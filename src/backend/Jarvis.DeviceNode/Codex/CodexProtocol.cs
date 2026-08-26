using System.Collections.Concurrent;
using System.Diagnostics;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Threading.Channels;
using Jarvis.Application.Devices;
using Jarvis.Infrastructure.Observability;

namespace Jarvis.DeviceNode.Codex;

public static class CodexProtocolMethods
{
    public const string Initialize = "initialize";
    public const string Initialized = "initialized";
    public const string ThreadStart = "thread/start";
    public const string ThreadResume = "thread/resume";
    public const string TurnStart = "turn/start";
    public const string TurnInterrupt = "turn/interrupt";
    public const string ProcessExited = "process/exited";

    public static readonly IReadOnlySet<string> ServerApprovalRequests = new HashSet<string>(StringComparer.Ordinal)
    {
        "item/commandExecution/requestApproval",
        "item/fileChange/requestApproval",
        "item/permissions/requestApproval"
    };
}

public sealed record CodexRuntimeOptions(
    string BinaryPath = "codex",
    IReadOnlyList<string>? Arguments = null,
    int RequestTimeoutMs = 60_000,
    int MaxRestartAttempts = 3)
{
    public IReadOnlyList<string> EffectiveArguments => Arguments ?? ["app-server"];

    public string? WorkingDirectory { get; init; }

    public CapabilityPolicy? Policy { get; init; }

    public IReadOnlyDictionary<string, string>? Environment { get; init; }
}

public sealed record CodexThreadHandle(string ThreadId, JsonElement RawResponse);

public sealed record CodexTurnHandle(string ThreadId, string TurnId, JsonElement RawResponse);

public sealed record CodexServerRequest(string RequestId, string Method, JsonElement Params);

public sealed record CodexRuntimeEvent(
    string Method,
    JsonElement? Params = null,
    string? RequestId = null,
    bool IsRequest = false);

public sealed class CodexProcessExitedEventArgs(int? exitCode, string stderrSummary) : EventArgs
{
    public int? ExitCode { get; } = exitCode;

    public string StderrSummary { get; } = stderrSummary;
}

public interface ICodexRuntime : IAsyncDisposable
{
    Task ProcessExit => Task.Delay(Timeout.InfiniteTimeSpan);

    Task InitializeAsync(CancellationToken cancellationToken = default);

    Task<CodexThreadHandle> StartThreadAsync(CapabilityPolicy policy, string? cwd, CancellationToken cancellationToken = default);

    Task<CodexThreadHandle> ResumeThreadAsync(string threadId, CapabilityPolicy policy, string? cwd, CancellationToken cancellationToken = default);

    Task<CodexTurnHandle> StartTurnAsync(string threadId, string input, CancellationToken cancellationToken = default);

    Task InterruptTurnAsync(string threadId, string turnId, CancellationToken cancellationToken = default);

    IAsyncEnumerable<CodexRuntimeEvent> ReadEventsAsync(CancellationToken cancellationToken = default);

    Task RespondToServerRequestAsync(CodexServerRequest request, object result, CancellationToken cancellationToken = default);

    string StderrSummary { get; }
}

public sealed class CodexAppServerClient : ICodexRuntime
{
    private static readonly JsonSerializerOptions JsonOptions = new(JsonSerializerDefaults.Web);
    private readonly CodexRuntimeOptions options;
    private readonly ConcurrentDictionary<string, TaskCompletionSource<JsonElement>> pending = new(StringComparer.Ordinal);
    private readonly Channel<CodexRuntimeEvent> events = Channel.CreateUnbounded<CodexRuntimeEvent>(new UnboundedChannelOptions { SingleReader = false, SingleWriter = true });
    private readonly SemaphoreSlim writeGate = new(1, 1);
    private readonly object lifecycleGate = new();
    private readonly TaskCompletionSource processExit = new(TaskCreationOptions.RunContinuationsAsynchronously);
    private int stderrLineCount;
    private Process? process;
    private Task? readTask;
    private Task? stderrTask;
    private int requestNumber;
    private bool initialized;
    private int exitObserved;
    private bool stopping;
    private CapabilityPolicy? activePolicy;

    public event EventHandler<CodexProcessExitedEventArgs>? ProcessExited;

    public Task ProcessExit => processExit.Task;

    public bool IsProcessExited
    {
        get
        {
            lock (lifecycleGate)
            {
                return process is { HasExited: true };
            }
        }
    }

    public CodexAppServerClient(CodexRuntimeOptions? options = null)
    {
        this.options = options ?? new CodexRuntimeOptions();
    }

    public string StderrSummary
    {
        get => Volatile.Read(ref stderrLineCount) == 0
            ? string.Empty
            : "Codex app-server emitted stderr; content was redacted by the Device Node.";
    }

    public async Task InitializeAsync(CancellationToken cancellationToken = default)
    {
        lock (lifecycleGate)
        {
            if (initialized)
            {
                return;
            }

            if (process is not null)
            {
                throw new InvalidOperationException("Codex app-server is already starting.");
            }

            stopping = false;
            exitObserved = 0;

            var startInfo = new ProcessStartInfo
            {
                FileName = options.BinaryPath,
                UseShellExecute = false,
                RedirectStandardInput = true,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                CreateNoWindow = true
            };
            if (options.WorkingDirectory is not null)
            {
                if (!Path.IsPathFullyQualified(options.WorkingDirectory) || !Directory.Exists(options.WorkingDirectory))
                {
                    throw new InvalidOperationException("Codex working directory must be an existing absolute path.");
                }

                if (options.Policy is not null && !options.Policy.IsAllowedPath(options.WorkingDirectory, write: false))
                {
                    throw new UnauthorizedAccessException("Codex working directory is outside the capability envelope.");
                }

                startInfo.WorkingDirectory = options.WorkingDirectory;
            }
            var environment = options.Policy?.BuildMinimalEnvironment(options.Environment) ?? options.Environment;
            if (environment is not null)
            {
                startInfo.Environment.Clear();
                foreach (var pair in environment)
                {
                    startInfo.Environment[pair.Key] = pair.Value;
                }
            }
            foreach (var argument in options.EffectiveArguments)
            {
                startInfo.ArgumentList.Add(argument);
            }

            process = new Process { StartInfo = startInfo, EnableRaisingEvents = true };
            if (!process.Start())
            {
                process.Dispose();
                process = null;
                throw new InvalidOperationException("Codex app-server could not be started.");
            }

            JarvisTelemetry.CodexProcessStarts.Add(
                1,
                JarvisTelemetry.BoundedTags(("operation", "start")).ToArray());

            readTask = ReadStdoutAsync(process, CancellationToken.None);
            stderrTask = ReadStderrAsync(process, CancellationToken.None);
        }

        var initializeParams = new
        {
            clientInfo = new { name = "jarvis-device-node", title = "Jarvis Device Node", version = "phase-4" },
            capabilities = new { experimentalApi = false, requestAttestation = false }
        };
        await SendRequestAsync(CodexProtocolMethods.Initialize, initializeParams, cancellationToken);
        await SendNotificationAsync(CodexProtocolMethods.Initialized, null, cancellationToken);
        initialized = true;
    }

    public async Task<CodexThreadHandle> StartThreadAsync(CapabilityPolicy policy, string? cwd, CancellationToken cancellationToken = default)
    {
        await EnsureInitializedAsync(cancellationToken);
        ValidateCwd(policy, cwd);
        activePolicy = policy;
        var parameters = new JsonObject
        {
            ["cwd"] = cwd,
            ["approvalPolicy"] = "on-request",
            ["sandbox"] = policy.WriteFiles ? "workspace-write" : "read-only",
            ["developerInstructions"] = BuildCapabilityInstructions(policy)
        };
        var response = await SendRequestAsync(CodexProtocolMethods.ThreadStart, parameters, cancellationToken);
        return ParseThreadResponse(response);
    }

    public async Task<CodexThreadHandle> ResumeThreadAsync(string threadId, CapabilityPolicy policy, string? cwd, CancellationToken cancellationToken = default)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(threadId);
        JarvisTelemetry.CodexThreadResumes.Add(
            1,
            JarvisTelemetry.BoundedTags(("operation", "resume")).ToArray());
        try
        {
            await EnsureInitializedAsync(cancellationToken);
            ValidateCwd(policy, cwd);
            activePolicy = policy;
            var parameters = new JsonObject
            {
                ["threadId"] = threadId,
                ["cwd"] = cwd,
                ["approvalPolicy"] = "on-request",
                ["sandbox"] = policy.WriteFiles ? "workspace-write" : "read-only",
                ["developerInstructions"] = BuildCapabilityInstructions(policy)
            };
            var response = await SendRequestAsync(CodexProtocolMethods.ThreadResume, parameters, cancellationToken);
            return ParseThreadResponse(response);
        }
        catch (Exception) when (!cancellationToken.IsCancellationRequested)
        {
            JarvisTelemetry.CodexThreadResumeFailures.Add(
                1,
                JarvisTelemetry.BoundedTags(("operation", "resume")).ToArray());
            throw;
        }
    }

    public async Task<CodexTurnHandle> StartTurnAsync(string threadId, string input, CancellationToken cancellationToken = default)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(threadId);
        ArgumentException.ThrowIfNullOrWhiteSpace(input);
        var startedAt = Stopwatch.GetTimestamp();
        try
        {
            await EnsureInitializedAsync(cancellationToken);
            // SandboxPolicy is the app-server's typed capability projection. The
            // legacy sandbox mode on thread/start/resume remains for compatibility.
            var parameters = new JsonObject
            {
                ["threadId"] = threadId,
                ["input"] = JsonSerializer.SerializeToNode(new[] { new { type = "text", text = input } }),
                ["sandboxPolicy"] = activePolicy is { } policy
                    ? policy.WriteFiles
                        ? JsonSerializer.SerializeToNode(new { type = "workspaceWrite", networkAccess = policy.Network, writableRoots = policy.AllowedRoots })
                        : JsonSerializer.SerializeToNode(new { type = "readOnly", networkAccess = policy.Network })
                    : null
            };
            var response = await SendRequestAsync(CodexProtocolMethods.TurnStart, parameters, cancellationToken);
            var responseObject = response.ValueKind == JsonValueKind.Object && response.TryGetProperty("turn", out var turn)
                ? turn
                : response;
            var turnId = responseObject.TryGetProperty("id", out var id) ? id.GetString() : null;
            if (string.IsNullOrWhiteSpace(turnId))
            {
                throw new InvalidDataException("Codex turn/start response did not contain turn.id.");
            }

            return new CodexTurnHandle(threadId, turnId, response);
        }
        finally
        {
            JarvisTelemetry.CodexTurnDuration.Record(
                Stopwatch.GetElapsedTime(startedAt).TotalMilliseconds,
                JarvisTelemetry.BoundedTags(("operation", "start")).ToArray());
        }
    }

    public async Task InterruptTurnAsync(string threadId, string turnId, CancellationToken cancellationToken = default)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(threadId);
        ArgumentException.ThrowIfNullOrWhiteSpace(turnId);
        await EnsureInitializedAsync(cancellationToken);
        await SendRequestAsync(CodexProtocolMethods.TurnInterrupt, new { threadId, turnId }, cancellationToken);
    }

    public async IAsyncEnumerable<CodexRuntimeEvent> ReadEventsAsync([System.Runtime.CompilerServices.EnumeratorCancellation] CancellationToken cancellationToken = default)
    {
        await foreach (var item in events.Reader.ReadAllAsync(cancellationToken))
        {
            yield return item;
        }
    }

    public Task RespondToServerRequestAsync(CodexServerRequest request, object result, CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(request);
        return SendResponseAsync(request.RequestId, result, cancellationToken);
    }

    public async ValueTask DisposeAsync()
    {
        Process? current;
        lock (lifecycleGate)
        {
            current = process;
            process = null;
            initialized = false;
            stopping = true;
        }

        events.Writer.TryComplete();
        if (current is not null)
        {
            try
            {
                if (!current.HasExited)
                {
                    current.Kill(entireProcessTree: true);
                }
            }
            catch (InvalidOperationException)
            {
            }

            await current.WaitForExitAsync().ConfigureAwait(false);
            current.Dispose();
        }

        if (readTask is not null)
        {
            await readTask.ConfigureAwait(false);
        }

        if (stderrTask is not null)
        {
            await stderrTask.ConfigureAwait(false);
        }

        foreach (var waiter in pending.Values)
        {
            waiter.TrySetException(new OperationCanceledException("Codex app-server stopped."));
        }

        writeGate.Dispose();
    }

    private async Task EnsureInitializedAsync(CancellationToken cancellationToken)
    {
        if (!initialized)
        {
            await InitializeAsync(cancellationToken);
        }
    }

    private async Task<JsonElement> SendRequestAsync(string method, object? parameters, CancellationToken cancellationToken)
    {
        var id = Interlocked.Increment(ref requestNumber).ToString(System.Globalization.CultureInfo.InvariantCulture);
        var waiter = new TaskCompletionSource<JsonElement>(TaskCreationOptions.RunContinuationsAsynchronously);
        if (!pending.TryAdd(id, waiter))
        {
            throw new InvalidOperationException("Codex request id collision.");
        }

        try
        {
            await SendJsonAsync(new { id = int.Parse(id, System.Globalization.CultureInfo.InvariantCulture), method, @params = parameters }, cancellationToken);
            using var timeout = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
            timeout.CancelAfter(Math.Clamp(options.RequestTimeoutMs, 1_000, 300_000));
            using var registration = timeout.Token.Register(() => waiter.TrySetCanceled(timeout.Token));
            return await waiter.Task.ConfigureAwait(false);
        }
        finally
        {
            pending.TryRemove(id, out _);
        }
    }

    private Task SendNotificationAsync(string method, object? parameters, CancellationToken cancellationToken) => SendJsonAsync(new { method, @params = parameters }, cancellationToken);

    private async Task SendResponseAsync(string requestId, object result, CancellationToken cancellationToken) => await SendJsonAsync(new { id = ParseRequestId(requestId), result }, cancellationToken);

    private async Task SendJsonAsync(object value, CancellationToken cancellationToken)
    {
        var current = process ?? throw new InvalidOperationException("Codex app-server is not running.");
        var line = JsonSerializer.Serialize(value, JsonOptions);
        await writeGate.WaitAsync(cancellationToken);
        try
        {
            await current.StandardInput.WriteLineAsync(line.AsMemory(), cancellationToken);
            await current.StandardInput.FlushAsync(cancellationToken);
        }
        finally
        {
            writeGate.Release();
        }
    }

    private async Task ReadStdoutAsync(Process current, CancellationToken cancellationToken)
    {
        try
        {
            while (!cancellationToken.IsCancellationRequested && await current.StandardOutput.ReadLineAsync(cancellationToken) is { } line)
            {
                if (string.IsNullOrWhiteSpace(line))
                {
                    continue;
                }

                try
                {
                    using var document = JsonDocument.Parse(line);
                    var root = document.RootElement;
                    if (root.TryGetProperty("id", out var idElement))
                    {
                        var requestId = RequestIdText(idElement);
                        if (root.TryGetProperty("result", out var result) && pending.TryGetValue(requestId, out var success))
                        {
                            success.TrySetResult(result.Clone());
                        }
                        else if (root.TryGetProperty("error", out var error) && pending.TryGetValue(requestId, out var failure))
                        {
                            JarvisTelemetry.CodexProtocolErrors.Add(
                                1,
                                JarvisTelemetry.BoundedTags(("operation", "response")).ToArray());
                            failure.TrySetException(new InvalidOperationException($"Codex protocol error: {error.GetRawText()}"));
                        }
                        else if (root.TryGetProperty("method", out var method))
                        {
                            var @params = root.TryGetProperty("params", out var requestParams) ? requestParams.Clone() : default;
                            await events.Writer.WriteAsync(new CodexRuntimeEvent(method.GetString() ?? string.Empty, @params, requestId, true), cancellationToken);
                        }
                    }
                    else if (root.TryGetProperty("method", out var notificationMethod))
                    {
                        var @params = root.TryGetProperty("params", out var notificationParams) ? notificationParams.Clone() : default;
                        await events.Writer.WriteAsync(new CodexRuntimeEvent(notificationMethod.GetString() ?? string.Empty, @params), cancellationToken);
                    }
                }
                catch (JsonException exception)
                {
                    JarvisTelemetry.CodexProtocolErrors.Add(
                        1,
                        JarvisTelemetry.BoundedTags(("operation", "json")).ToArray());
                    await events.Writer.WriteAsync(new CodexRuntimeEvent("protocol/error", JsonSerializer.SerializeToElement(new { error = exception.Message })), cancellationToken);
                }
            }

            ObserveProcessExit(current, null);
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
        {
        }
        catch (Exception exception)
        {
            ObserveProcessExit(current, exception);
        }
    }

    private void ObserveProcessExit(Process current, Exception? failure)
    {
        if (Interlocked.Exchange(ref exitObserved, 1) != 0)
        {
            return;
        }

        processExit.TrySetResult();
        lock (lifecycleGate)
        {
            initialized = false;
            if (stopping)
            {
                return;
            }
        }

        foreach (var waiter in pending.Values)
        {
            waiter.TrySetException(failure ?? new EndOfStreamException("Codex app-server exited before completing its response."));
        }

        int? exitCode = null;
        try
        {
            exitCode = current.HasExited ? current.ExitCode : null;
        }
        catch (InvalidOperationException)
        {
        }

        var parameters = JsonSerializer.SerializeToElement(new
        {
            exitCode,
            error = failure?.Message,
            stderr = StderrSummary
        });
        events.Writer.TryWrite(new CodexRuntimeEvent(CodexProtocolMethods.ProcessExited, parameters));
        try
        {
            ProcessExited?.Invoke(this, new CodexProcessExitedEventArgs(exitCode, StderrSummary));
        }
        catch
        {
            // Observers cannot affect protocol shutdown or recovery.
        }

        events.Writer.TryComplete(failure ?? new EndOfStreamException("Codex app-server exited."));
    }

    private async Task ReadStderrAsync(Process current, CancellationToken cancellationToken)
    {
        while (!cancellationToken.IsCancellationRequested && await current.StandardError.ReadLineAsync(cancellationToken) is not null)
        {
            Interlocked.Increment(ref stderrLineCount);
        }
    }

    private static CodexThreadHandle ParseThreadResponse(JsonElement response)
    {
        var thread = response.ValueKind == JsonValueKind.Object && response.TryGetProperty("thread", out var threadElement)
            ? threadElement
            : response;
        var threadId = thread.TryGetProperty("id", out var id) ? id.GetString() : null;
        if (string.IsNullOrWhiteSpace(threadId))
        {
            throw new InvalidDataException("Codex thread response did not contain thread.id.");
        }

        return new CodexThreadHandle(threadId, response);
    }

    private static object ParseRequestId(string requestId) => long.TryParse(requestId, out var number) ? number : requestId;

    private static string RequestIdText(JsonElement id) => id.ValueKind == JsonValueKind.String ? id.GetString() ?? string.Empty : id.GetRawText();

    private static void ValidateCwd(CapabilityPolicy policy, string? cwd)
    {
        if (cwd is null)
        {
            return;
        }

        if (!Path.IsPathFullyQualified(cwd) || !policy.IsAllowedPath(cwd, write: false))
        {
            throw new UnauthorizedAccessException("Codex cwd is outside the capability envelope.");
        }
    }

    private static string BuildCapabilityInstructions(CapabilityPolicy policy)
    {
        var roots = string.Join(", ", policy.AllowedRoots.Select(root => JsonSerializer.Serialize(root)));
        return $"Access local files only within these task roots: {roots}. "
            + "Never access credential or secret paths such as .env, .ssh, cloud credential directories, keys, or secrets.json. "
            + "Treat any path outside the task roots as unavailable; a permission request outside them will be denied.";
    }
}
