using Jarvis.Application.Devices;
using Jarvis.Infrastructure.Observability;

namespace Jarvis.DeviceNode.Codex;

public enum CodexSupervisorStatus
{
    Running,
    Recovering,
    Succeeded,
    Failed
}

public sealed record CodexSupervisorOptions(
    int MaxRestartAttempts = 3,
    TimeSpan? RestartDelay = null)
{
    public TimeSpan EffectiveRestartDelay => RestartDelay is { } delay && delay >= TimeSpan.Zero
        ? delay
        : TimeSpan.FromMilliseconds(250);
}

public sealed record CodexSupervisorState(
    CodexSupervisorStatus Status,
    int RestartAttempt,
    string? ThreadId,
    string? Error);

/// <summary>
/// Owns the restart boundary around one Codex task. A failed runtime is
/// disposed before a new process is created; a known thread is always resumed
/// rather than silently starting a second thread for the same task.
/// </summary>
public sealed class CodexProcessSupervisor
{
    private readonly Func<CancellationToken, Task<ICodexRuntime>> runtimeFactory;
    private readonly CodexSupervisorOptions options;

    public CodexProcessSupervisor(
        Func<CancellationToken, Task<ICodexRuntime>> runtimeFactory,
        CodexSupervisorOptions? options = null)
    {
        this.runtimeFactory = runtimeFactory ?? throw new ArgumentNullException(nameof(runtimeFactory));
        this.options = options ?? new CodexSupervisorOptions();
        if (this.options.MaxRestartAttempts < 0)
        {
            throw new ArgumentOutOfRangeException(nameof(options), "MaxRestartAttempts cannot be negative.");
        }
    }

    public async Task<T> RunAsync<T>(
        CapabilityPolicy policy,
        string? cwd,
        string? existingThreadId,
        Func<ICodexRuntime, string, CancellationToken, Task<T>> execute,
        Action<CodexSupervisorState>? onState = null,
        Func<CodexSupervisorState, CancellationToken, Task>? onStateAsync = null,
        CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(policy);
        ArgumentNullException.ThrowIfNull(execute);

        var threadId = string.IsNullOrWhiteSpace(existingThreadId) ? null : existingThreadId;
        for (var restartAttempt = 0; ; restartAttempt++)
        {
            cancellationToken.ThrowIfCancellationRequested();
            await using var runtime = await runtimeFactory(cancellationToken).ConfigureAwait(false);
            try
            {
                await runtime.InitializeAsync(cancellationToken).ConfigureAwait(false);
                var thread = threadId is null
                    ? await runtime.StartThreadAsync(policy, cwd, cancellationToken).ConfigureAwait(false)
                    : await runtime.ResumeThreadAsync(threadId, policy, cwd, cancellationToken).ConfigureAwait(false);
                threadId = thread.ThreadId;

                var result = await execute(runtime, threadId, cancellationToken).ConfigureAwait(false);
                var succeeded = new CodexSupervisorState(CodexSupervisorStatus.Succeeded, restartAttempt, threadId, null);
                Notify(onState, succeeded);
                await NotifyAsync(onStateAsync, succeeded, cancellationToken).ConfigureAwait(false);
                return result;
            }
            catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
            {
                throw;
            }
            catch (CodexTurnStartUncertainException exception)
            {
                var failed = new CodexSupervisorState(CodexSupervisorStatus.Failed, restartAttempt, threadId, exception.Message);
                Notify(onState, failed);
                await NotifyAsync(onStateAsync, failed, cancellationToken).ConfigureAwait(false);
                throw;
            }
            catch (Exception exception)
            {
                var nextAttempt = restartAttempt + 1;
                var error = string.IsNullOrWhiteSpace(runtime.StderrSummary)
                    ? exception.Message
                    : $"{exception.Message} ({runtime.StderrSummary.Trim()})";
                if (nextAttempt > options.MaxRestartAttempts)
                {
                    var failed = new CodexSupervisorState(CodexSupervisorStatus.Failed, restartAttempt, threadId, error);
                    Notify(onState, failed);
                    await NotifyAsync(onStateAsync, failed, cancellationToken).ConfigureAwait(false);
                    throw new InvalidOperationException("Codex process recovery attempts were exhausted.", exception);
                }

                var recovering = new CodexSupervisorState(CodexSupervisorStatus.Recovering, nextAttempt, threadId, error);
                JarvisTelemetry.CodexProcessRestarts.Add(
                    1,
                    JarvisTelemetry.BoundedTags(("operation", "recover")).ToArray());
                Notify(onState, recovering);
                await NotifyAsync(onStateAsync, recovering, cancellationToken).ConfigureAwait(false);
                await Task.Delay(options.EffectiveRestartDelay, cancellationToken).ConfigureAwait(false);
            }
        }
    }

    private static void Notify(Action<CodexSupervisorState>? onState, CodexSupervisorState state)
    {
        try
        {
            onState?.Invoke(state);
        }
        catch
        {
            // State reporting is observational. A listener must not disable
            // the recovery boundary or change the task's terminal outcome.
        }
    }

    private static async Task NotifyAsync(
        Func<CodexSupervisorState, CancellationToken, Task>? onStateAsync,
        CodexSupervisorState state,
        CancellationToken cancellationToken)
    {
        if (onStateAsync is null)
        {
            return;
        }

        try
        {
            await onStateAsync(state, cancellationToken).ConfigureAwait(false);
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
        {
            throw;
        }
        catch
        {
            // State reporting is observational, just like the synchronous hook.
        }
    }
}
