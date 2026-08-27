using System.Collections.Concurrent;
using System.Diagnostics;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Threading.Channels;
using Jarvis.Application.Devices;
using Jarvis.Application.Tasks;
using Jarvis.Contracts;
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
    public const string ServerRequestResolved = "serverRequest/resolved";
    public const string ToolRequestUserInput = "item/tool/requestUserInput";

    public static readonly IReadOnlySet<string> ServerApprovalRequests = new HashSet<string>(StringComparer.Ordinal)
    {
        "item/commandExecution/requestApproval",
        "item/fileChange/requestApproval",
        "item/permissions/requestApproval"
    };
}

/// <summary>
/// Parses only the pinned 0.146.0 ToolRequestUserInputParams shape and builds
/// the exact ToolRequestUserInputResponse envelope expected by Codex.
/// </summary>
public static class CodexUserInputProtocol
{
    public static bool TryParse(
        string requestId,
        Guid executionId,
        JsonElement parameters,
        long nowMs,
        out DeviceTaskUserInputRequest request,
        out string error)
        => TryParse(requestId, true, executionId, parameters, nowMs, out request, out error);

    public static bool TryParse(
        string requestId,
        bool requestIdIsString,
        Guid executionId,
        JsonElement parameters,
        long nowMs,
        out DeviceTaskUserInputRequest request,
        out string error)
    {
        request = default!;
        error = string.Empty;
        if (parameters.ValueKind != JsonValueKind.Object)
        {
            error = "ToolRequestUserInputParams must be an object.";
            return false;
        }

        if (!TryGetRequiredString(parameters, "itemId", out var itemId)
            || !TryGetRequiredString(parameters, "threadId", out var threadId)
            || !TryGetRequiredString(parameters, "turnId", out var turnId)
            || !parameters.TryGetProperty("questions", out var questionsElement)
            || questionsElement.ValueKind != JsonValueKind.Array)
        {
            error = "ToolRequestUserInputParams is missing a required field.";
            return false;
        }

        var questions = new List<TaskUserInputQuestion>();
        foreach (var questionElement in questionsElement.EnumerateArray())
        {
            if (questionElement.ValueKind != JsonValueKind.Object
                || !TryGetRequiredString(questionElement, "header", out var header)
                || !TryGetRequiredString(questionElement, "id", out var id)
                || !TryGetRequiredString(questionElement, "question", out var question))
            {
                error = "ToolRequestUserInputQuestion is invalid.";
                return false;
            }

            if (!TryGetOptionalBoolean(questionElement, "isOther", out var isOther)
                || !TryGetOptionalBoolean(questionElement, "isSecret", out var isSecret))
            {
                error = "ToolRequestUserInputQuestion boolean fields are invalid.";
                return false;
            }

            IReadOnlyList<TaskUserInputOption>? options = null;
            if (questionElement.TryGetProperty("options", out var optionsElement))
            {
                if (optionsElement.ValueKind == JsonValueKind.Array)
                {
                    var parsedOptions = new List<TaskUserInputOption>();
                    foreach (var optionElement in optionsElement.EnumerateArray())
                    {
                        if (optionElement.ValueKind != JsonValueKind.Object
                            || !TryGetRequiredString(optionElement, "description", out var description)
                            || !TryGetRequiredString(optionElement, "label", out var label))
                        {
                            error = "ToolRequestUserInputOption is invalid.";
                            return false;
                        }

                        parsedOptions.Add(new TaskUserInputOption(description, label));
                    }

                    options = parsedOptions;
                }
                else if (optionsElement.ValueKind != JsonValueKind.Null)
                {
                    error = "ToolRequestUserInputQuestion.options must be an array or null.";
                    return false;
                }
            }

            questions.Add(new TaskUserInputQuestion(header, id, question, isOther, isSecret, options));
        }

        long? autoResolutionMs = null;
        if (parameters.TryGetProperty("autoResolutionMs", out var autoResolutionElement))
        {
            if (autoResolutionElement.ValueKind == JsonValueKind.Number)
            {
                if (!autoResolutionElement.TryGetInt64(out var parsed) || parsed < 0)
                {
                    error = "autoResolutionMs must be a non-negative uint64 within the supported bound.";
                    return false;
                }

                autoResolutionMs = parsed;
            }
            else if (autoResolutionElement.ValueKind != JsonValueKind.Null)
            {
                error = "autoResolutionMs must be an integer or null.";
                return false;
            }
        }

        var candidate = new DeviceTaskUserInputRequest(
            executionId,
            requestId,
            itemId,
            questions,
            threadId,
            turnId,
            autoResolutionMs,
            requestIdIsString);
        if (!TaskUserInputValidation.TryValidateRequest(candidate, nowMs, out error))
        {
            return false;
        }

        request = candidate with
        {
            RequestId = requestId.Trim(),
            ItemId = itemId.Trim(),
            ThreadId = threadId.Trim(),
            TurnId = turnId.Trim(),
            Questions = questions.Select(NormalizeQuestion).ToArray()
        };
        return true;
    }

    public static object CreateResponse(IReadOnlyDictionary<string, TaskUserInputAnswer> answers) => new
    {
        answers = answers.ToDictionary(
            pair => pair.Key,
            pair => new { answers = pair.Value.Answers },
            StringComparer.Ordinal)
    };

    private static TaskUserInputQuestion NormalizeQuestion(TaskUserInputQuestion question) => question with
    {
        Header = question.Header.Trim(),
        Id = question.Id.Trim(),
        Question = question.Question.Trim(),
        Options = question.Options?.Select(option => option with
        {
            Label = option.Label.Trim(),
            Description = option.Description.Trim()
        }).ToArray()
    };

    private static bool TryGetRequiredString(JsonElement element, string name, out string value)
    {
        value = string.Empty;
        if (!element.TryGetProperty(name, out var property)
            || property.ValueKind != JsonValueKind.String)
        {
            return false;
        }

        value = property.GetString() ?? string.Empty;
        return !string.IsNullOrWhiteSpace(value);
    }

    private static bool TryGetOptionalBoolean(JsonElement element, string name, out bool value)
    {
        value = false;
        if (!element.TryGetProperty(name, out var property))
        {
            return true;
        }

        if (property.ValueKind == JsonValueKind.True)
        {
            value = true;
            return true;
        }

        return property.ValueKind == JsonValueKind.False;
    }
}

public sealed record CodexRuntimeOptions(
    string BinaryPath = "codex",
    IReadOnlyList<string>? Arguments = null,
    int RequestTimeoutMs = 60_000,
    int MaxRestartAttempts = 3)
{
    public IReadOnlyList<string> EffectiveArguments
    {
        get
        {
            var result = (Arguments ?? ["app-server"]).ToList();
            if (PermissionProfile is not null)
            {
                foreach (var overrideValue in PermissionProfile.CliConfigOverrides)
                {
                    result.Add("-c");
                    result.Add(overrideValue);
                }
            }

            return result;
        }
    }

    public string? WorkingDirectory { get; init; }

    public CapabilityPolicy? Policy { get; init; }

    public string? CodexHome { get; init; }

    public CodexTaskPermissionProfile? PermissionProfile { get; init; }

    public IReadOnlyDictionary<string, string>? Environment { get; init; }
}

public sealed record CodexThreadHandle(string ThreadId, JsonElement RawResponse);

public sealed record CodexTurnHandle(string ThreadId, string TurnId, JsonElement RawResponse);

public sealed record CodexServerRequest(string RequestId, string Method, JsonElement Params, bool RequestIdIsString = true);

public sealed record CodexRuntimeEvent(
    string Method,
    JsonElement? Params = null,
    string? RequestId = null,
    bool IsRequest = false,
    bool RequestIdIsString = true);

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

            if (options.PermissionProfile is not null)
            {
                if (options.Policy is null)
                {
                    throw new InvalidOperationException("A Codex task permission profile requires a capability policy.");
                }

                CodexHomeValidator.Validate(options.CodexHome);
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
            var environment = BuildProcessEnvironment();
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

    private IReadOnlyDictionary<string, string>? BuildProcessEnvironment()
    {
        if (options.PermissionProfile is not null)
        {
            return options.Policy!.BuildMinimalEnvironment(new Dictionary<string, string>(StringComparer.Ordinal)
            {
                ["CODEX_HOME"] = options.CodexHome!
            });
        }

        return options.Policy?.BuildMinimalEnvironment(options.Environment) ?? options.Environment;
    }

    public async Task<CodexThreadHandle> StartThreadAsync(CapabilityPolicy policy, string? cwd, CancellationToken cancellationToken = default)
    {
        var profile = RequirePermissionProfile();
        await EnsureInitializedAsync(cancellationToken);
        ValidateCwd(policy, cwd);
        var parameters = new JsonObject
        {
            ["cwd"] = cwd,
            ["approvalPolicy"] = "on-request",
            ["developerInstructions"] = BuildCapabilityInstructions(policy)
        };
        var response = await SendRequestAsync(CodexProtocolMethods.ThreadStart, parameters, cancellationToken);
        return ParseThreadResponse(response, profile.Id);
    }

    public async Task<CodexThreadHandle> ResumeThreadAsync(string threadId, CapabilityPolicy policy, string? cwd, CancellationToken cancellationToken = default)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(threadId);
        JarvisTelemetry.CodexThreadResumes.Add(
            1,
            JarvisTelemetry.BoundedTags(("operation", "resume")).ToArray());
        try
        {
            var profile = RequirePermissionProfile();
            await EnsureInitializedAsync(cancellationToken);
            ValidateCwd(policy, cwd);
            var parameters = new JsonObject
            {
                ["threadId"] = threadId,
                ["cwd"] = cwd,
                ["approvalPolicy"] = "on-request",
                ["developerInstructions"] = BuildCapabilityInstructions(policy)
            };
            var response = await SendRequestAsync(CodexProtocolMethods.ThreadResume, parameters, cancellationToken);
            return ParseThreadResponse(response, profile.Id);
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
            var parameters = new JsonObject
            {
                ["threadId"] = threadId,
                ["input"] = JsonSerializer.SerializeToNode(new[] { new { type = "text", text = input } })
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
        return SendResponseAsync(request.RequestId, request.RequestIdIsString, result, cancellationToken);
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
        if (!pending.TryAdd(RequestKey(id, requestIdIsString: false), waiter))
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
            pending.TryRemove(RequestKey(id, requestIdIsString: false), out _);
        }
    }

    private Task SendNotificationAsync(string method, object? parameters, CancellationToken cancellationToken) => SendJsonAsync(new { method, @params = parameters }, cancellationToken);

    private async Task SendResponseAsync(string requestId, bool requestIdIsString, object result, CancellationToken cancellationToken) => await SendJsonAsync(new { id = ParseRequestId(requestId, requestIdIsString), result }, cancellationToken);

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
                        var requestKey = RequestKey(requestId.Text, requestId.IsString);
                        if (root.TryGetProperty("result", out var result) && pending.TryGetValue(requestKey, out var success))
                        {
                            success.TrySetResult(result.Clone());
                        }
                        else if (root.TryGetProperty("error", out var error) && pending.TryGetValue(requestKey, out var failure))
                        {
                            JarvisTelemetry.CodexProtocolErrors.Add(
                                1,
                                JarvisTelemetry.BoundedTags(("operation", "response")).ToArray());
                            failure.TrySetException(new InvalidOperationException($"Codex protocol error: {error.GetRawText()}"));
                        }
                        else if (root.TryGetProperty("method", out var method))
                        {
                            var @params = root.TryGetProperty("params", out var requestParams) ? requestParams.Clone() : default;
                            await events.Writer.WriteAsync(new CodexRuntimeEvent(method.GetString() ?? string.Empty, @params, requestId.Text, true, requestId.IsString), cancellationToken);
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

    private CodexTaskPermissionProfile RequirePermissionProfile() => options.PermissionProfile
        ?? throw new InvalidOperationException("Every Codex task requires a native permission profile.");

    private static CodexThreadHandle ParseThreadResponse(JsonElement response, string expectedProfileId)
    {
        if (response.ValueKind != JsonValueKind.Object
            || !response.TryGetProperty("activePermissionProfile", out var activeProfile)
            || activeProfile.ValueKind != JsonValueKind.Object
            || !activeProfile.TryGetProperty("id", out var activeProfileId)
            || activeProfileId.ValueKind != JsonValueKind.String
            || !string.Equals(activeProfileId.GetString(), expectedProfileId, StringComparison.Ordinal))
        {
            throw new InvalidDataException(
                $"Codex thread response did not confirm activePermissionProfile.id '{expectedProfileId}'.");
        }

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

    private static object ParseRequestId(string requestId, bool requestIdIsString)
    {
        if (requestIdIsString)
        {
            return requestId;
        }

        // The adapter keeps the original JSON token text. Serializing a parsed
        // JsonElement preserves a numeric id without accidentally turning it
        // into a JSON-RPC string (including numbers outside Int64).
        try
        {
            using var document = JsonDocument.Parse(requestId);
            return document.RootElement.ValueKind == JsonValueKind.Number
                ? document.RootElement.Clone()
                : requestId;
        }
        catch (JsonException)
        {
            return requestId;
        }
    }

    private static (string Text, bool IsString) RequestIdText(JsonElement id) => id.ValueKind == JsonValueKind.String
        ? (id.GetString() ?? string.Empty, true)
        : (id.GetRawText(), false);

    private static string RequestKey(string requestId, bool requestIdIsString) =>
        $"{(requestIdIsString ? 's' : 'n')}:{requestId}";

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
