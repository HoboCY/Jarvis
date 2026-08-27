using System.Diagnostics;
using System.Text.Json;
using Jarvis.Application.Devices;
using Jarvis.Contracts;
using Jarvis.DeviceNode.Codex;
using Jarvis.Infrastructure.Observability;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;

namespace Jarvis.DeviceNode;

public interface IDeviceApprovalDecisionWaiter
{
    Task<DeviceApprovalResolution?> WaitAsync(Guid taskId, Guid approvalId, CancellationToken cancellationToken);
}

public sealed record DeviceApprovalResolution(ApprovalDecisionValue Decision, ApprovalScopeValue Scope);

public sealed class FailClosedApprovalDecisionWaiter : IDeviceApprovalDecisionWaiter
{
    public async Task<DeviceApprovalResolution?> WaitAsync(Guid taskId, Guid approvalId, CancellationToken cancellationToken)
    {
        await Task.Delay(Timeout.InfiniteTimeSpan, cancellationToken).ConfigureAwait(false);
        return null;
    }
}

public sealed class PollingApprovalDecisionWaiter(
    IDeviceNodeControlPlane controlPlane,
    IOptions<DeviceNodeOptions> options,
    TimeProvider timeProvider) : IDeviceApprovalDecisionWaiter
{
    private readonly DeviceNodeOptions nodeOptions = options.Value;

    public async Task<DeviceApprovalResolution?> WaitAsync(Guid taskId, Guid approvalId, CancellationToken cancellationToken)
    {
        using var timer = new PeriodicTimer(
            TimeSpan.FromMilliseconds(Math.Max(100, nodeOptions.PollingIntervalMs)),
            timeProvider);
        while (await timer.WaitForNextTickAsync(cancellationToken).ConfigureAwait(false))
        {
            var status = await controlPlane.GetApprovalAsync(taskId, approvalId, cancellationToken).ConfigureAwait(false);
            if (status.Status == ApprovalStatusValue.Approved)
            {
                return new DeviceApprovalResolution(
                    ApprovalDecisionValue.Approve,
                    status.Scope ?? ApprovalScopeValue.Once);
            }

            if (status.Status is ApprovalStatusValue.Denied or ApprovalStatusValue.Expired or ApprovalStatusValue.Cancelled)
            {
                return new DeviceApprovalResolution(
                    ApprovalDecisionValue.Deny,
                    status.Scope ?? ApprovalScopeValue.Once);
            }
        }

        return null;
    }
}

public interface IDeviceUserInputWaiter
{
    Task<DeviceUserInputResolution?> WaitAsync(
        Guid taskId,
        Guid executionId,
        string requestId,
        bool requestIdIsString,
        string leaseOwner,
        CancellationToken cancellationToken);
}

public sealed record DeviceUserInputResolution(
    IReadOnlyDictionary<string, TaskUserInputAnswer>? Answers,
    TaskUserInputStatusValue Status = TaskUserInputStatusValue.Answered);

public sealed class FailClosedUserInputWaiter : IDeviceUserInputWaiter
{
    public async Task<DeviceUserInputResolution?> WaitAsync(
        Guid taskId,
        Guid executionId,
        string requestId,
        bool requestIdIsString,
        string leaseOwner,
        CancellationToken cancellationToken)
    {
        await Task.Delay(Timeout.InfiniteTimeSpan, cancellationToken).ConfigureAwait(false);
        return null;
    }
}

public sealed class PollingUserInputWaiter(
    IDeviceNodeControlPlane controlPlane,
    IOptions<DeviceNodeOptions> options,
    TimeProvider timeProvider) : IDeviceUserInputWaiter
{
    private readonly DeviceNodeOptions nodeOptions = options.Value;

    public async Task<DeviceUserInputResolution?> WaitAsync(
        Guid taskId,
        Guid executionId,
        string requestId,
        bool requestIdIsString,
        string leaseOwner,
        CancellationToken cancellationToken)
    {
        using var timer = new PeriodicTimer(
            TimeSpan.FromMilliseconds(Math.Max(100, nodeOptions.PollingIntervalMs)),
            timeProvider);
        while (await timer.WaitForNextTickAsync(cancellationToken).ConfigureAwait(false))
        {
            var status = await controlPlane.GetUserInputAsync(
                taskId,
                executionId,
                requestId,
                requestIdIsString,
                leaseOwner,
                cancellationToken).ConfigureAwait(false);
            if (status.Status == TaskUserInputStatusValue.Answered && status.Answers is not null)
            {
                return new DeviceUserInputResolution(status.Answers);
            }

            if (status.Status is TaskUserInputStatusValue.Cleared or TaskUserInputStatusValue.Expired)
            {
                return new DeviceUserInputResolution(null, status.Status);
            }
        }

        return null;
    }
}

public sealed partial class DeviceNodeWorker(
    IOptions<DeviceNodeOptions> options,
    IDeviceNodeControlPlane controlPlane,
    ILogger<DeviceNodeWorker> logger,
    IDeviceApprovalDecisionWaiter? approvalWaiter = null,
    TimeProvider? timeProvider = null,
    IDeviceUserInputWaiter? userInputWaiter = null) : BackgroundService
{
    private static readonly JsonSerializerOptions JsonOptions = new(JsonSerializerDefaults.Web);
    private readonly DeviceNodeOptions nodeOptions = options.Value;
    private readonly IDeviceApprovalDecisionWaiter approvalWaiter = approvalWaiter ?? new FailClosedApprovalDecisionWaiter();
    private readonly IDeviceUserInputWaiter userInputWaiter = userInputWaiter ?? new FailClosedUserInputWaiter();
    private readonly TimeProvider timeProvider = timeProvider ?? TimeProvider.System;

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        if (nodeOptions.DeviceId == Guid.Empty || string.IsNullOrWhiteSpace(nodeOptions.DeviceCredential))
        {
            LogIdentityNotConfigured(logger);
            return;
        }

        var policy = CapabilityPolicy.Create(nodeOptions.Capabilities.ToEnvelope());
        var nextHeartbeatAt = DateTimeOffset.MinValue;
        while (!stoppingToken.IsCancellationRequested)
        {
            try
            {
                if (DateTimeOffset.UtcNow >= nextHeartbeatAt)
                {
                    await controlPlane.HeartbeatAsync(
                        new DeviceHeartbeatRequest(
                            CapabilityNames(nodeOptions.Capabilities),
                            nodeOptions.Capabilities.AllowedRoots),
                        $"device-heartbeat:{nodeOptions.DeviceId:D}:{DateTimeOffset.UtcNow.ToUnixTimeSeconds()}",
                        stoppingToken).ConfigureAwait(false);
                    nextHeartbeatAt = DateTimeOffset.UtcNow.AddMilliseconds(Math.Max(1, nodeOptions.HeartbeatIntervalMs));
                }

                var active = await controlPlane.ListActiveAsync(stoppingToken).ConfigureAwait(false);
                if (active.Items.Count > 0)
                {
                    await ExecuteClaimAsync(active.Items[0], policy, stoppingToken).ConfigureAwait(false);
                    continue;
                }

                var claim = await controlPlane.ClaimAsync(
                    new DeviceTaskClaimRequest(nodeOptions.DeviceId.ToString("N"), ToContractEnvelope(nodeOptions.Capabilities)),
                    $"device-claim:{nodeOptions.DeviceId:D}:{Guid.NewGuid():N}",
                    stoppingToken).ConfigureAwait(false);
                if (claim.Claimed)
                {
                    await ExecuteClaimAsync(claim, policy, stoppingToken).ConfigureAwait(false);
                }
                else
                {
                    await Task.Delay(Math.Max(25, nodeOptions.PollingIntervalMs), stoppingToken).ConfigureAwait(false);
                }
            }
            catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested)
            {
                break;
            }
            catch (Exception exception)
            {
                LogWorkerLoopFailure(logger, exception);
                await Task.Delay(Math.Max(25, nodeOptions.PollingIntervalMs), stoppingToken).ConfigureAwait(false);
            }
        }
    }

    public async Task ExecuteClaimAsync(
        DeviceTaskClaimResponse claim,
        CapabilityPolicy policy,
        CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(claim);
        ArgumentNullException.ThrowIfNull(policy);
        if (!claim.Claimed || claim.Task is null || claim.Execution is null || claim.LeaseOwner is null)
        {
            return;
        }

        var task = claim.Task;
        var execution = claim.Execution;
        var leaseOwner = claim.LeaseOwner;
        if (claim.CapabilityEnvelope is null)
        {
            await AppendEventSafeAsync(
                task.Id,
                new DeviceTaskEventRequest(
                    ClientEventId: $"device-capability-envelope-missing:{execution.Id:D}",
                    ExecutionId: execution.Id,
                    EventType: "task.failed",
                    PayloadJson: "{\"reason\":\"capability_envelope_missing\"}",
                    ErrorCode: "capability_envelope_missing",
                    ErrorMessage: "The Codex task claim did not include a capability envelope."),
                leaseOwner,
                $"device-capability-envelope-missing:{execution.Id:D}",
                cancellationToken).ConfigureAwait(false);
            return;
        }

        var envelope = claim.CapabilityEnvelope;
        var effectivePolicy = policy;
        var requestedRoots = envelope.AllowedRoots ?? Array.Empty<string>();
        var canWriteRoots = policy.WriteFiles && envelope.WriteFiles;
        var canReadRoots = policy.ReadFiles && envelope.ReadFiles;
        var roots = requestedRoots
            .Where(root => canWriteRoots
                ? policy.IsAllowedPath(root, write: true)
                : canReadRoots && policy.IsAllowedPath(root, write: false))
            .ToArray();
        effectivePolicy = CapabilityPolicy.Create(new CapabilityEnvelope(
            ReadFiles: policy.ReadFiles && envelope.ReadFiles,
            WriteFiles: policy.WriteFiles && envelope.WriteFiles,
            RunCommands: policy.RunCommands && envelope.RunCommands,
            Network: policy.Network && envelope.Network,
            AllowedRoots: roots));
        CodexHomeValidator.Validate(nodeOptions.CodexHome);
        var permissionProfile = CodexTaskPermissionProfile.Create(task.Id, effectivePolicy);
        var effectiveWorkingDirectory = ResolveWorkingDirectory(nodeOptions.WorkingDirectory, effectivePolicy);
        var turnState = new ActiveTurnState(
            execution.CodexThreadId,
            execution.CodexTurnId,
            execution.CodexTurnStartRequestedAtMs is not null);
        var supervisor = new CodexProcessSupervisor(
            _ =>
            {
                var runtimeOptions = new CodexRuntimeOptions(nodeOptions.CodexBinaryPath, nodeOptions.CodexArguments)
                {
                    Policy = effectivePolicy,
                    CodexHome = nodeOptions.CodexHome,
                    PermissionProfile = permissionProfile,
                    WorkingDirectory = effectiveWorkingDirectory,
                    Environment = effectivePolicy.BuildMinimalEnvironment(new Dictionary<string, string>(StringComparer.Ordinal)
                    {
                        ["CODEX_HOME"] = nodeOptions.CodexHome
                    })
                };
                return Task.FromResult<ICodexRuntime>(new CodexAppServerClient(runtimeOptions));
            },
            new CodexSupervisorOptions(
                Math.Max(0, nodeOptions.MaxRestartAttempts),
                TimeSpan.FromMilliseconds(Math.Max(0, nodeOptions.RestartDelayMs))));

        try
        {
            await supervisor.RunAsync(
                effectivePolicy,
                effectiveWorkingDirectory,
                execution.CodexThreadId,
                (runtime, threadId, token) => ExecuteTurnFromDurableStateAsync(
                    runtime,
                    task,
                    execution,
                    threadId,
                    leaseOwner,
                    turnState,
                    effectivePolicy,
                    token),
                onStateAsync: (state, token) => ObserveSupervisorStateAsync(state, task, execution, leaseOwner, token),
                cancellationToken: cancellationToken).ConfigureAwait(false);
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
        {
            throw;
        }
        catch (CodexTurnStartUncertainException exception)
        {
            LogExecutionFailure(logger, exception, task.Id);
            await AppendEventSafeAsync(
                task.Id,
                new DeviceTaskEventRequest(
                    ClientEventId: $"device-turn-uncertain:{execution.Id:D}",
                    ExecutionId: execution.Id,
                    EventType: "task.failed",
                    PayloadJson: "{\"reason\":\"codex_turn_outcome_uncertain\"}",
                    ErrorCode: "codex_turn_outcome_uncertain",
                    ErrorMessage: "Codex turn start may have been accepted; automatic replay was refused."),
                leaseOwner,
                $"device-turn-uncertain:{execution.Id:D}",
                cancellationToken).ConfigureAwait(false);
        }
        catch (Exception exception)
        {
            LogExecutionFailure(logger, exception, task.Id);
            await AppendEventSafeAsync(
                task.Id,
                new DeviceTaskEventRequest(
                    ClientEventId: $"device-failed:{execution.Id:D}",
                    ExecutionId: execution.Id,
                    EventType: "task.failed",
                    PayloadJson: JsonSerializer.Serialize(new { reason = "codex_recovery_exhausted" }, JsonOptions),
                    ErrorCode: "codex_recovery_exhausted",
                    ErrorMessage: "Codex process recovery attempts were exhausted."),
                leaseOwner,
                $"device-failed:{execution.Id:D}",
                cancellationToken).ConfigureAwait(false);
        }
    }

    private async Task<string> ExecuteTurnFromDurableStateAsync(
        ICodexRuntime runtime,
        TaskResponse claimedTask,
        TaskExecutionResponse claimedExecution,
        string threadId,
        string leaseOwner,
        ActiveTurnState turnState,
        CapabilityPolicy policy,
        CancellationToken cancellationToken)
    {
        // A restarted app-server must reconstruct pending input from the
        // Control Plane claim, never from runtime memory or the old process.
        var durableTask = await controlPlane.GetTaskAsync(claimedTask.Id, cancellationToken).ConfigureAwait(false);
        var durableExecution = durableTask.Execution is { Id: var executionId } execution
            && executionId == claimedExecution.Id
            ? execution
            : claimedExecution;
        if (durableTask.Status is TaskStatusValue.Succeeded or TaskStatusValue.Failed or TaskStatusValue.Cancelled
            || durableExecution.Status is TaskExecutionStatusValue.Succeeded or TaskExecutionStatusValue.Failed or TaskExecutionStatusValue.Cancelled)
        {
            // A fail-closed resolution (serverRequest/resolved, expiry, or
            // process exit) is already durable. Do not let the supervisor
            // restart boundary create another turn for that terminal outcome.
            return "The durable Codex task is already terminal.";
        }

        return await ExecuteTurnAsync(
            runtime,
            durableTask,
            durableExecution,
            threadId,
            leaseOwner,
            turnState,
            policy,
            cancellationToken).ConfigureAwait(false);
    }

    private async Task<string> ExecuteTurnAsync(
        ICodexRuntime runtime,
        TaskResponse task,
        TaskExecutionResponse execution,
        string threadId,
        string leaseOwner,
        ActiveTurnState turnState,
        CapabilityPolicy policy,
        CancellationToken cancellationToken)
    {
        CodexTurnHandle turn;
        if (!string.IsNullOrWhiteSpace(turnState.TurnId)
            && string.Equals(turnState.ThreadId, threadId, StringComparison.Ordinal))
        {
            turn = new CodexTurnHandle(threadId, turnState.TurnId!, default);
        }
        else
        {
            if (turnState.StartAttempted)
            {
                throw new CodexTurnStartUncertainException(
                    threadId,
                    new InvalidOperationException("A persisted turn-start intent has no confirmed turn identifier."));
            }

            await controlPlane.AppendEventAsync(
                task.Id,
                new DeviceTaskEventRequest(
                    $"codex-turn-starting:{execution.Id:D}",
                    execution.Id,
                    "codex.turn.starting",
                    CodexThreadId: threadId),
                leaseOwner,
                $"codex-turn-starting:{execution.Id:D}",
                cancellationToken).ConfigureAwait(false);
            turnState.ThreadId = threadId;
            turnState.StartAttempted = true;
            turn = await StartTurnOnceAsync(runtime, threadId, task.Goal, turnState, cancellationToken).ConfigureAwait(false);
        }

        await controlPlane.AppendEventAsync(
            task.Id,
            new DeviceTaskEventRequest(
                $"codex-turn-started:{turn.TurnId}",
                execution.Id,
                "codex.turn.started",
                CodexThreadId: threadId,
                CodexTurnId: turn.TurnId),
            leaseOwner,
            $"codex-turn-started:{turn.TurnId}",
            cancellationToken).ConfigureAwait(false);

        using var turnCancellation = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        var cancellationRequested = false;
        var leaseRenewal = RenewLeaseLoopAsync(task.Id, leaseOwner, turnCancellation.Token);
        var cancellationMonitor = MonitorCancellationAsync(
            task.Id,
            runtime,
            threadId,
            turn.TurnId,
            () => cancellationRequested = true,
            turnCancellation);
        var progressNumber = 0;
        var pendingUserInputRequestId = task.PendingUserInput?.RequestId;
        var pendingUserInputRequestIdIsString = task.PendingUserInput?.RequestIdIsString ?? true;
        Task<DeviceUserInputResolution?>? userInputTask = null;
        if (task.PendingUserInput is not null)
        {
            userInputTask = userInputWaiter.WaitAsync(
                task.Id,
                execution.Id,
                task.PendingUserInput.RequestId,
                pendingUserInputRequestIdIsString,
                leaseOwner,
                turnCancellation.Token);
        }

        await using var runtimeEvents = runtime.ReadEventsAsync(turnCancellation.Token).GetAsyncEnumerator(turnCancellation.Token);
        Task<bool>? nextRuntimeEvent = null;
        try
        {
            while (true)
            {
                cancellationToken.ThrowIfCancellationRequested();
                nextRuntimeEvent ??= runtimeEvents.MoveNextAsync().AsTask();
                if (userInputTask is not null)
                {
                    await Task.WhenAny(
                        nextRuntimeEvent,
                        userInputTask,
                        runtime.ProcessExit,
                        leaseRenewal,
                        cancellationMonitor).ConfigureAwait(false);

                    // These signals share one arbitration point. A lease loss,
                    // cancellation, or process exit always wins over an answer
                    // that happened to become visible at the same time.
                    if (leaseRenewal.IsCompleted)
                    {
                        await leaseRenewal.ConfigureAwait(false);
                    }

                    if (cancellationMonitor.IsCompleted)
                    {
                        await cancellationMonitor.ConfigureAwait(false);
                        if (cancellationRequested)
                        {
                            await AppendCancellationAsync(task, execution, leaseOwner, cancellationToken).ConfigureAwait(false);
                            return "Codex task cancelled.";
                        }
                    }

                    if (runtime.ProcessExit.IsCompleted)
                    {
                        await ResolveUserInputSafelyAsync(
                            task,
                            execution,
                            pendingUserInputRequestId!,
                            pendingUserInputRequestIdIsString,
                            leaseOwner,
                            $"codex-user-input-process-exit:{RequestIdentitySuffix(pendingUserInputRequestId, pendingUserInputRequestIdIsString)}",
                            cancellationToken).ConfigureAwait(false);
                        throw new EndOfStreamException("Codex app-server exited while waiting for a user-input answer.");
                    }

                    // A resolved notification wins a race with a completed poll so the
                    // Device Node never answers a request the server has already cleared.
                    if (nextRuntimeEvent.IsCompleted)
                    {
                        if (!await nextRuntimeEvent.ConfigureAwait(false))
                        {
                            break;
                        }

                        var eventWhileWaiting = runtimeEvents.Current;
                        nextRuntimeEvent = null;
                        if (await HandleResolvedUserInputAsync(
                                eventWhileWaiting,
                                pendingUserInputRequestId,
                                pendingUserInputRequestIdIsString,
                                execution,
                                threadId,
                                task,
                                leaseOwner,
                                turnCancellation.Token).ConfigureAwait(false))
                        {
                            return "Codex cleared the user-input request before it was answered.";
                        }

                        if (eventWhileWaiting.Method == CodexProtocolMethods.ProcessExited)
                        {
                            await ResolveUserInputSafelyAsync(
                                task,
                                execution,
                                pendingUserInputRequestId,
                                pendingUserInputRequestIdIsString,
                                leaseOwner,
                                $"codex-user-input-process-exit:{RequestIdentitySuffix(pendingUserInputRequestId, pendingUserInputRequestIdIsString)}",
                                cancellationToken).ConfigureAwait(false);
                            throw new EndOfStreamException("Codex app-server exited during a turn.");
                        }

                        if (eventWhileWaiting.Method is "turn/completed" or "turn/complete")
                        {
                            await ResolveUserInputSafelyAsync(
                                task,
                                execution,
                                pendingUserInputRequestId,
                                pendingUserInputRequestIdIsString,
                                leaseOwner,
                                $"codex-user-input-completed:{task.Id:D}:{RequestIdentitySuffix(pendingUserInputRequestId, pendingUserInputRequestIdIsString)}",
                                turnCancellation.Token).ConfigureAwait(false);
                            return "Codex completed while the user-input request was pending.";
                        }

                        continue;
                    }

                    var resolution = await userInputTask.ConfigureAwait(false);
                    userInputTask = null;
                    if (resolution is null)
                    {
                        return "Codex user-input request was not answered.";
                    }

                    if (resolution.Status != TaskUserInputStatusValue.Answered
                        || resolution.Answers is null)
                    {
                        var cancellationState = cancellationRequested
                            ? TaskStatusValue.CancellationRequested
                            : (await controlPlane.GetTaskAsync(task.Id, cancellationToken).ConfigureAwait(false)).Status;
                        if (cancellationState == TaskStatusValue.CancellationRequested)
                        {
                            await runtime.InterruptTurnAsync(threadId, turn.TurnId, cancellationToken).ConfigureAwait(false);
                            await AppendCancellationAsync(task, execution, leaseOwner, cancellationToken).ConfigureAwait(false);
                            return "Codex task cancelled.";
                        }

                        return "Codex user-input request was cleared before it was answered.";
                    }

                    // Polling the answer and writing the JSON-RPC response are
                    // separate operations. Re-read the durable projection and
                    // require the same request to still be waiting before send.
                    DeviceTaskUserInputResponse? currentInput = null;
                    try
                    {
                        currentInput = await controlPlane.GetUserInputAsync(
                            task.Id,
                            execution.Id,
                            pendingUserInputRequestId!,
                            pendingUserInputRequestIdIsString,
                            leaseOwner,
                            cancellationToken).ConfigureAwait(false);
                    }
                    catch (DeviceNodeControlPlaneException exception)
                        when (exception.StatusCode is System.Net.HttpStatusCode.Conflict
                            or System.Net.HttpStatusCode.NotFound)
                    {
                        // The durable request was cleared/expired or the lease
                        // changed. The answer must not cross that boundary.
                    }

                    if (currentInput is null
                        || currentInput.Status != TaskUserInputStatusValue.Answered
                        || currentInput.Answers is null
                        || !string.Equals(currentInput.RequestId, pendingUserInputRequestId, StringComparison.Ordinal)
                        || currentInput.RequestIdIsString != pendingUserInputRequestIdIsString)
                    {
                        var currentTask = await controlPlane.GetTaskAsync(task.Id, cancellationToken).ConfigureAwait(false);
                        if (currentTask.Status == TaskStatusValue.CancellationRequested || cancellationRequested)
                        {
                            await runtime.InterruptTurnAsync(threadId, turn.TurnId, cancellationToken).ConfigureAwait(false);
                            await AppendCancellationAsync(task, execution, leaseOwner, cancellationToken).ConfigureAwait(false);
                            return "Codex task cancelled.";
                        }

                        return "Codex user-input request was cleared before it was answered.";
                    }

                    // Cancellation can be committed after the poll completes but
                    // before the response write. Re-check the durable task at the
                    // single arbitration point so a late answer never crosses the
                    // cancellation boundary.
                    var latestTask = await controlPlane.GetTaskAsync(task.Id, cancellationToken).ConfigureAwait(false);
                    if (cancellationRequested || latestTask.Status == TaskStatusValue.CancellationRequested)
                    {
                        await runtime.InterruptTurnAsync(threadId, turn.TurnId, cancellationToken).ConfigureAwait(false);
                        await AppendCancellationAsync(task, execution, leaseOwner, cancellationToken).ConfigureAwait(false);
                        return "Codex task cancelled.";
                    }

                    await runtime.RespondToServerRequestAsync(
                        new CodexServerRequest(
                            pendingUserInputRequestId ?? string.Empty,
                            CodexProtocolMethods.ToolRequestUserInput,
                            default,
                            pendingUserInputRequestIdIsString),
                        CodexUserInputProtocol.CreateResponse(resolution.Answers),
                        cancellationToken).ConfigureAwait(false);
                    pendingUserInputRequestId = null;
                    pendingUserInputRequestIdIsString = true;
                    continue;
                }

                await Task.WhenAny(
                    nextRuntimeEvent,
                    runtime.ProcessExit,
                    leaseRenewal,
                    cancellationMonitor).ConfigureAwait(false);

                if (leaseRenewal.IsCompleted)
                {
                    await leaseRenewal.ConfigureAwait(false);
                }

                if (cancellationMonitor.IsCompleted)
                {
                    await cancellationMonitor.ConfigureAwait(false);
                    if (cancellationRequested)
                    {
                        await runtime.InterruptTurnAsync(threadId, turn.TurnId, cancellationToken).ConfigureAwait(false);
                        await AppendCancellationAsync(task, execution, leaseOwner, cancellationToken).ConfigureAwait(false);
                        return "Codex task cancelled.";
                    }
                }

                if (runtime.ProcessExit.IsCompleted)
                {
                    await ResolveUserInputSafelyAsync(
                        task,
                        execution,
                        pendingUserInputRequestId,
                        pendingUserInputRequestIdIsString,
                        leaseOwner,
                        $"codex-user-input-process-exit:{RequestIdentitySuffix(pendingUserInputRequestId, pendingUserInputRequestIdIsString)}",
                        cancellationToken).ConfigureAwait(false);
                    throw new EndOfStreamException("Codex app-server exited during a turn.");
                }

                if (!await nextRuntimeEvent.ConfigureAwait(false))
                {
                    break;
                }

                var runtimeEvent = runtimeEvents.Current;
                nextRuntimeEvent = null;
                if (runtimeEvent.Method == CodexProtocolMethods.ProcessExited)
                {
                    await ResolveUserInputSafelyAsync(
                        task,
                        execution,
                        pendingUserInputRequestId,
                        pendingUserInputRequestIdIsString,
                        leaseOwner,
                        $"codex-user-input-process-exit:{RequestIdentitySuffix(pendingUserInputRequestId, pendingUserInputRequestIdIsString)}",
                        cancellationToken).ConfigureAwait(false);
                    throw new EndOfStreamException("Codex app-server exited during a turn.");
                }

                if (cancellationRequested)
                {
                    await AppendCancellationAsync(task, execution, leaseOwner, cancellationToken).ConfigureAwait(false);
                    return "Codex task cancelled.";
                }

                if (runtimeEvent.IsRequest && CodexProtocolMethods.ServerApprovalRequests.Contains(runtimeEvent.Method))
                {
                    var approvalKind = runtimeEvent.Method switch
                    {
                        "item/commandExecution/requestApproval" => "command",
                        "item/fileChange/requestApproval" => "file_change",
                        _ => "permission"
                    };
                    JarvisTelemetry.CodexApprovals.Add(
                        1,
                        JarvisTelemetry.BoundedTags(("approval.kind", approvalKind)).ToArray());
                    if (approvalKind == "command")
                    {
                        JarvisTelemetry.CodexCommandApprovals.Add(
                            1,
                            JarvisTelemetry.BoundedTags(("approval.kind", approvalKind)).ToArray());
                    }
                    else if (approvalKind == "file_change")
                    {
                        JarvisTelemetry.CodexFileChangeApprovals.Add(
                            1,
                            JarvisTelemetry.BoundedTags(("approval.kind", approvalKind)).ToArray());
                    }
                    var approval = await CreateApprovalAsync(task, execution, runtimeEvent, leaseOwner, cancellationToken).ConfigureAwait(false);
                    var resolution = await WaitForApprovalOrRuntimeExitAsync(
                        runtime,
                        task.Id,
                        approval.ApprovalId,
                        cancellationToken).ConfigureAwait(false);
                    await runtime.RespondToServerRequestAsync(
                        new CodexServerRequest(
                            runtimeEvent.RequestId ?? string.Empty,
                            runtimeEvent.Method,
                            runtimeEvent.Params ?? default,
                            runtimeEvent.RequestIdIsString),
                        CodexApprovalResponseFactory.Create(runtimeEvent.Method, resolution.Decision, resolution.Scope, runtimeEvent.Params, policy),
                        cancellationToken).ConfigureAwait(false);
                    if (resolution.Decision == ApprovalDecisionValue.Deny)
                    {
                        await runtime.InterruptTurnAsync(threadId, turn.TurnId, cancellationToken).ConfigureAwait(false);
                        return "Codex operation denied by the user.";
                    }

                    continue;
                }

                if (runtimeEvent.IsRequest && runtimeEvent.Method == CodexProtocolMethods.ToolRequestUserInput)
                {
                    if (string.IsNullOrWhiteSpace(runtimeEvent.RequestId)
                        || runtimeEvent.Params is not JsonElement userInputParams
                        || !CodexUserInputProtocol.TryParse(
                            runtimeEvent.RequestId,
                            runtimeEvent.RequestIdIsString,
                            execution.Id,
                            userInputParams,
                            timeProvider.GetUtcNow().ToUnixTimeMilliseconds(),
                            out var userInputRequest,
                            out _))
                    {
                        await AppendFailureAsync(
                            task,
                            execution,
                            leaseOwner,
                            "codex_user_input_invalid",
                            "Codex sent an invalid or unsupported user-input request.",
                            cancellationToken).ConfigureAwait(false);
                        return "Codex user-input request was rejected.";
                    }

                    var persisted = await controlPlane.CreateUserInputAsync(
                        task.Id,
                        userInputRequest,
                        leaseOwner,
                        $"codex-user-input:{execution.Id:D}:{RequestIdentitySuffix(userInputRequest.RequestId, userInputRequest.RequestIdIsString)}",
                        cancellationToken).ConfigureAwait(false);
                    if (persisted.Status == TaskUserInputStatusValue.Answered && persisted.Answers is not null)
                    {
                        await runtime.RespondToServerRequestAsync(
                            new CodexServerRequest(runtimeEvent.RequestId, runtimeEvent.Method, userInputParams, runtimeEvent.RequestIdIsString),
                            CodexUserInputProtocol.CreateResponse(persisted.Answers),
                            cancellationToken).ConfigureAwait(false);
                        continue;
                    }

                    if (persisted.Status != TaskUserInputStatusValue.Pending)
                    {
                        await AppendFailureAsync(
                            task,
                            execution,
                            leaseOwner,
                            "codex_user_input_not_pending",
                            "The Codex user-input request was not left pending by the Control Plane.",
                            cancellationToken).ConfigureAwait(false);
                        return "Codex user-input request was not left pending.";
                    }

                    pendingUserInputRequestId = persisted.RequestId;
                    pendingUserInputRequestIdIsString = persisted.RequestIdIsString;
                    userInputTask = userInputWaiter.WaitAsync(
                        task.Id,
                        execution.Id,
                        persisted.RequestId,
                        persisted.RequestIdIsString,
                        leaseOwner,
                        turnCancellation.Token);
                    continue;
                }

                if (runtimeEvent.Method.StartsWith("item/", StringComparison.Ordinal)
                    || runtimeEvent.Method.StartsWith("turn/", StringComparison.Ordinal))
                {
                    var progress = ExtractProgress(runtimeEvent.Params);
                    if (!string.IsNullOrWhiteSpace(progress))
                    {
                        progressNumber++;
                        await controlPlane.AppendEventAsync(
                            task.Id,
                            new DeviceTaskEventRequest(
                                $"codex-progress:{turn.TurnId}:{progressNumber}",
                                execution.Id,
                                "codex.progress",
                                PayloadJson: runtimeEvent.Params?.GetRawText(),
                                ProgressSummary: progress),
                            leaseOwner,
                            $"codex-progress:{turn.TurnId}:{progressNumber}",
                            cancellationToken).ConfigureAwait(false);
                    }

                    if (runtimeEvent.Method is "turn/completed" or "turn/complete")
                    {
                        var status = ExtractStatus(runtimeEvent.Params);
                        var summary = progress ?? "Codex task completed.";
                        if (pendingUserInputRequestId is not null)
                        {
                            await AppendFailureAsync(
                                task,
                                execution,
                                leaseOwner,
                                "codex_user_input_unresolved",
                                "Codex completed while a user-input request was still pending.",
                                cancellationToken).ConfigureAwait(false);
                            return "Codex completed with unresolved user input.";
                        }
                        if (cancellationRequested || string.Equals(status, "cancelled", StringComparison.OrdinalIgnoreCase))
                        {
                            await AppendCancellationAsync(task, execution, leaseOwner, cancellationToken).ConfigureAwait(false);
                            return "Codex task cancelled.";
                        }

                        if (string.Equals(status, "failed", StringComparison.OrdinalIgnoreCase))
                        {
                            await AppendFailureAsync(task, execution, leaseOwner, "codex_turn_failed", summary, cancellationToken).ConfigureAwait(false);
                            return summary;
                        }

                        await AppendResultAsync(task, execution, leaseOwner, turn, runtimeEvent, summary, policy, cancellationToken).ConfigureAwait(false);
                        return summary;
                    }
                }
                else if (runtimeEvent.Method == "protocol/error")
                {
                    JarvisTelemetry.CodexProtocolErrors.Add(
                        1,
                        JarvisTelemetry.BoundedTags(("operation", "event")).ToArray());
                }
            }

            if (cancellationRequested)
            {
                await AppendCancellationAsync(task, execution, leaseOwner, cancellationToken).ConfigureAwait(false);
                return "Codex task cancelled.";
            }

            throw new EndOfStreamException("Codex app-server ended the event stream without a completed turn.");
        }
        finally
        {
            turnCancellation.Cancel();
            try
            {
                await Task.WhenAll(leaseRenewal, cancellationMonitor).ConfigureAwait(false);
            }
            catch (OperationCanceledException) when (turnCancellation.IsCancellationRequested)
            {
            }
        }
    }

    private static async Task<CodexTurnHandle> StartTurnOnceAsync(
        ICodexRuntime runtime,
        string threadId,
        string goal,
        ActiveTurnState turnState,
        CancellationToken cancellationToken)
    {
        try
        {
            var turn = await runtime.StartTurnAsync(threadId, goal, cancellationToken).ConfigureAwait(false);
            turnState.ThreadId = threadId;
            turnState.TurnId = turn.TurnId;
            return turn;
        }
        catch (Exception exception) when (exception is not OperationCanceledException)
        {
            throw new CodexTurnStartUncertainException(threadId, exception);
        }
    }

    private async Task<bool> HandleResolvedUserInputAsync(
        CodexRuntimeEvent runtimeEvent,
        string? pendingRequestId,
        bool pendingRequestIdIsString,
        TaskExecutionResponse execution,
        string threadId,
        TaskResponse task,
        string leaseOwner,
        CancellationToken cancellationToken)
    {
        if (!string.Equals(runtimeEvent.Method, CodexProtocolMethods.ServerRequestResolved, StringComparison.Ordinal)
            || string.IsNullOrWhiteSpace(pendingRequestId))
        {
            return false;
        }

        var resolvedRequest = ExtractResolvedRequestIdentity(runtimeEvent.Params);
        var resolvedThreadId = ExtractResolvedThreadId(runtimeEvent.Params);
        if (resolvedRequest is null
            || !string.Equals(resolvedRequest.Value.Text, pendingRequestId, StringComparison.Ordinal)
            || resolvedRequest.Value.IsString != pendingRequestIdIsString
            || !string.Equals(resolvedThreadId, threadId, StringComparison.Ordinal))
        {
            return false;
        }

        await controlPlane.ResolveUserInputAsync(
            task.Id,
            execution.Id,
            pendingRequestId,
            pendingRequestIdIsString,
            leaseOwner,
            $"codex-user-input-resolved:{task.Id:D}:{RequestIdentitySuffix(pendingRequestId, pendingRequestIdIsString)}",
            cancellationToken).ConfigureAwait(false);
        return true;
    }

    private async Task ResolveUserInputSafelyAsync(
        TaskResponse task,
        TaskExecutionResponse execution,
        string? requestId,
        bool requestIdIsString,
        string leaseOwner,
        string idempotencyKey,
        CancellationToken cancellationToken)
    {
        if (string.IsNullOrWhiteSpace(requestId))
        {
            return;
        }

        try
        {
            await controlPlane.ResolveUserInputAsync(
                task.Id,
                execution.Id,
                requestId,
                requestIdIsString,
                leaseOwner,
                idempotencyKey,
                cancellationToken).ConfigureAwait(false);
        }
        catch (Exception exception) when (exception is DeviceNodeControlPlaneException or HttpRequestException)
        {
            // A lost lease or an unavailable Control Plane is fail-closed: the
            // durable request remains for expiry/recovery and no answer is sent.
            LogEventPersistenceFailure(logger, exception, "task.userInputCleared", task.Id);
        }
    }

    private async Task<DeviceApprovalResolution> WaitForApprovalOrRuntimeExitAsync(
        ICodexRuntime runtime,
        Guid taskId,
        Guid approvalId,
        CancellationToken cancellationToken)
    {
        var startedAt = Stopwatch.GetTimestamp();
        using var approvalCancellation = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        try
        {
            var approvalTask = approvalWaiter.WaitAsync(taskId, approvalId, approvalCancellation.Token);
            var exitTask = runtime.ProcessExit;
            var completed = await Task.WhenAny(approvalTask, exitTask).ConfigureAwait(false);
            if (completed == exitTask)
            {
                approvalCancellation.Cancel();
                try
                {
                    await approvalTask.ConfigureAwait(false);
                }
                catch (OperationCanceledException) when (approvalCancellation.IsCancellationRequested)
                {
                }

                throw new EndOfStreamException("Codex app-server exited while waiting for an approval decision.");
            }

            return await approvalTask.ConfigureAwait(false)
                ?? new DeviceApprovalResolution(ApprovalDecisionValue.Deny, ApprovalScopeValue.Once);
        }
        finally
        {
            JarvisTelemetry.ApprovalWaitDuration.Record(
                Stopwatch.GetElapsedTime(startedAt).TotalMilliseconds,
                JarvisTelemetry.BoundedTags(("operation", "codex")).ToArray());
        }
    }

    private async Task<DeviceApprovalResponse> CreateApprovalAsync(
        TaskResponse task,
        TaskExecutionResponse execution,
        CodexRuntimeEvent runtimeEvent,
        string leaseOwner,
        CancellationToken cancellationToken)
    {
        var kind = runtimeEvent.Method switch
        {
            "item/commandExecution/requestApproval" => ApprovalKindValue.Command,
            "item/fileChange/requestApproval" => ApprovalKindValue.FileWrite,
            "item/permissions/requestApproval" => ApprovalKindValue.Permission,
            _ => throw new InvalidOperationException("Unsupported Codex approval request.")
        };
        var reason = ExtractReason(runtimeEvent.Params) ?? "Codex requested an approved operation.";
        var requestedActionJson = runtimeEvent.Params?.GetRawText() ?? "{}";
        return await controlPlane.CreateApprovalAsync(
            task.Id,
            new DeviceApprovalRequest(
                execution.Id,
                kind,
                reason,
                requestedActionJson,
                RequestId: runtimeEvent.RequestId),
            leaseOwner,
            $"codex-approval:{execution.Id:D}:{runtimeEvent.RequestId ?? Guid.NewGuid().ToString("N")}",
            cancellationToken).ConfigureAwait(false);
    }

    private async Task RenewLeaseLoopAsync(Guid taskId, string leaseOwner, CancellationToken cancellationToken)
    {
        using var timer = new PeriodicTimer(
            TimeSpan.FromMilliseconds(Math.Max(250, nodeOptions.HeartbeatIntervalMs / 3)),
            timeProvider);
        while (await timer.WaitForNextTickAsync(cancellationToken).ConfigureAwait(false))
        {
            var renewed = await controlPlane.RenewLeaseAsync(
                taskId,
                new DeviceTaskLeaseRenewRequest(leaseOwner),
                $"lease-renew:{taskId:D}:{Guid.NewGuid():N}",
                cancellationToken).ConfigureAwait(false);
            if (!renewed.Renewed)
            {
                throw new InvalidOperationException("The Device Node task lease could not be renewed.");
            }
        }
    }

    private async Task MonitorCancellationAsync(
        Guid taskId,
        ICodexRuntime runtime,
        string threadId,
        string turnId,
        Action markCancellationRequested,
        CancellationTokenSource turnCancellation)
    {
        using var timer = new PeriodicTimer(
            TimeSpan.FromMilliseconds(Math.Max(250, nodeOptions.PollingIntervalMs)),
            timeProvider);
        while (await timer.WaitForNextTickAsync(turnCancellation.Token).ConfigureAwait(false))
        {
            var task = await controlPlane.GetTaskAsync(taskId, turnCancellation.Token).ConfigureAwait(false);
            if (task.Status != TaskStatusValue.CancellationRequested)
            {
                continue;
            }

            markCancellationRequested();
            await runtime.InterruptTurnAsync(threadId, turnId, turnCancellation.Token).ConfigureAwait(false);
            return;
        }
    }

    private async Task AppendResultAsync(
        TaskResponse task,
        TaskExecutionResponse execution,
        string leaseOwner,
        CodexTurnHandle turn,
        CodexRuntimeEvent runtimeEvent,
        string summary,
        CapabilityPolicy policy,
        CancellationToken cancellationToken)
    {
        var artifacts = ExtractArtifacts(runtimeEvent.Params);
        ArtifactManifestValidator.EnsureLocalFilesValid(policy, artifacts);
        await controlPlane.AppendEventAsync(
            task.Id,
            new DeviceTaskEventRequest(
                $"codex-completed:{turn.TurnId}",
                execution.Id,
                "task.completed",
                PayloadJson: runtimeEvent.Params?.GetRawText(),
                ResultSummary: summary,
                Artifacts: artifacts),
            leaseOwner,
            $"codex-completed:{turn.TurnId}",
            cancellationToken).ConfigureAwait(false);
    }

    private async Task AppendCancellationAsync(
        TaskResponse task,
        TaskExecutionResponse execution,
        string leaseOwner,
        CancellationToken cancellationToken)
    {
        await controlPlane.AppendEventAsync(
            task.Id,
            new DeviceTaskEventRequest(
                $"codex-cancelled:{execution.Id:D}",
                execution.Id,
                "task.cancelled"),
            leaseOwner,
            $"codex-cancelled:{execution.Id:D}",
            cancellationToken).ConfigureAwait(false);
    }

    private async Task AppendFailureAsync(
        TaskResponse task,
        TaskExecutionResponse execution,
        string leaseOwner,
        string errorCode,
        string errorMessage,
        CancellationToken cancellationToken)
    {
        await controlPlane.AppendEventAsync(
            task.Id,
            new DeviceTaskEventRequest(
                $"codex-failed:{execution.Id:D}",
                execution.Id,
                "task.failed",
                PayloadJson: JsonSerializer.Serialize(new { reason = errorCode }, JsonOptions),
                ErrorCode: errorCode,
                ErrorMessage: errorMessage),
            leaseOwner,
            $"codex-failed:{execution.Id:D}",
            cancellationToken).ConfigureAwait(false);
    }

    private async Task ObserveSupervisorStateAsync(
        CodexSupervisorState state,
        TaskResponse task,
        TaskExecutionResponse execution,
        string leaseOwner,
        CancellationToken cancellationToken)
    {
        if (state.Status == CodexSupervisorStatus.Recovering)
        {
            await AppendEventSafeAsync(
                task.Id,
                new DeviceTaskEventRequest(
                    $"codex-recovering:{execution.Id:D}:{state.RestartAttempt}",
                    execution.Id,
                    "task.recovering",
                    PayloadJson: JsonSerializer.Serialize(new { state.Error, state.RestartAttempt }, JsonOptions)),
                leaseOwner,
                $"codex-recovering:{execution.Id:D}:{state.RestartAttempt}",
                cancellationToken).ConfigureAwait(false);
        }
    }

    private async Task AppendEventSafeAsync(
        Guid taskId,
        DeviceTaskEventRequest request,
        string leaseOwner,
        string idempotencyKey,
        CancellationToken cancellationToken)
    {
        try
        {
            await controlPlane.AppendEventAsync(taskId, request, leaseOwner, idempotencyKey, cancellationToken).ConfigureAwait(false);
        }
        catch (Exception exception) when (exception is DeviceNodeControlPlaneException or HttpRequestException)
        {
            LogEventPersistenceFailure(logger, exception, request.EventType, taskId);
        }
    }

    private static string? ExtractReason(JsonElement? parameters)
    {
        if (parameters is not JsonElement value || value.ValueKind != JsonValueKind.Object)
        {
            return null;
        }

        foreach (var name in new[] { "reason", "command", "title", "description" })
        {
            if (value.TryGetProperty(name, out var candidate) && candidate.ValueKind == JsonValueKind.String)
            {
                return candidate.GetString();
            }
        }

        return null;
    }

    private static (string Text, bool IsString)? ExtractResolvedRequestIdentity(JsonElement? parameters)
    {
        if (parameters is not JsonElement value || value.ValueKind != JsonValueKind.Object)
        {
            return null;
        }

        if (!value.TryGetProperty("requestId", out var requestId))
        {
            return null;
        }

        return requestId.ValueKind switch
        {
            JsonValueKind.String => (requestId.GetString() ?? string.Empty, true),
            JsonValueKind.Number => (requestId.GetRawText(), false),
            _ => null
        };
    }

    private static string? ExtractResolvedThreadId(JsonElement? parameters)
    {
        if (parameters is not JsonElement value
            || value.ValueKind != JsonValueKind.Object
            || !value.TryGetProperty("threadId", out var threadId)
            || threadId.ValueKind != JsonValueKind.String)
        {
            return null;
        }

        return threadId.GetString();
    }

    private static string RequestIdentitySuffix(string? requestId, bool requestIdIsString)
    {
        var value = $"{(requestIdIsString ? 's' : 'n')}:{requestId ?? string.Empty}";
        var digest = System.Security.Cryptography.SHA256.HashData(System.Text.Encoding.UTF8.GetBytes(value));
        return Convert.ToHexString(digest)[..16];
    }

    private static List<string> CapabilityNames(CapabilityEnvelopeOptions capabilities)
    {
        var names = new List<string>();
        if (capabilities.ReadFiles)
        {
            names.Add("localFiles");
        }

        if (capabilities.WriteFiles)
        {
            names.Add("writeFiles");
        }

        if (capabilities.RunCommands)
        {
            names.Add("runCommands");
        }

        if (capabilities.Network)
        {
            names.Add("network");
        }

        return names;
    }

    private static CapabilityEnvelopeContract ToContractEnvelope(CapabilityEnvelopeOptions capabilities) => new(
        capabilities.ReadFiles,
        capabilities.WriteFiles,
        capabilities.RunCommands,
        capabilities.Network,
        capabilities.AllowedRoots);

    private static string ResolveWorkingDirectory(string? configured, CapabilityPolicy policy)
    {
        if (!string.IsNullOrWhiteSpace(configured))
        {
            return configured;
        }

        return policy.AllowedRoots.Count > 0
            ? policy.AllowedRoots[0]
            : throw new InvalidOperationException("A Codex task requires at least one allowed root.");
    }

    private static string? ExtractProgress(JsonElement? parameters)
    {
        if (parameters is not JsonElement value || value.ValueKind != JsonValueKind.Object)
        {
            return null;
        }

        foreach (var name in new[] { "delta", "text", "summary", "message" })
        {
            if (value.TryGetProperty(name, out var candidate) && candidate.ValueKind == JsonValueKind.String)
            {
                var text = candidate.GetString();
                return text is null ? null : text.Length > 2_000 ? text[..2_000] : text;
            }
        }

        return null;
    }

    private static string? ExtractStatus(JsonElement? parameters)
    {
        if (parameters is not JsonElement value || value.ValueKind != JsonValueKind.Object)
        {
            return null;
        }

        if (value.TryGetProperty("status", out var status) && status.ValueKind == JsonValueKind.String)
        {
            return status.GetString();
        }

        if (value.TryGetProperty("turn", out var turn)
            && turn.ValueKind == JsonValueKind.Object
            && turn.TryGetProperty("status", out var turnStatus)
            && turnStatus.ValueKind == JsonValueKind.String)
        {
            return turnStatus.GetString();
        }

        return null;
    }

    private static ArtifactManifestEntry[] ExtractArtifacts(JsonElement? parameters)
    {
        if (parameters is not JsonElement value
            || value.ValueKind != JsonValueKind.Object
            || !value.TryGetProperty("artifacts", out var artifacts)
            || artifacts.ValueKind != JsonValueKind.Array)
        {
            return Array.Empty<ArtifactManifestEntry>();
        }

        try
        {
            return JsonSerializer.Deserialize<ArtifactManifestEntry[]>(artifacts.GetRawText(), JsonOptions)
                ?? Array.Empty<ArtifactManifestEntry>();
        }
        catch (JsonException)
        {
            return Array.Empty<ArtifactManifestEntry>();
        }
    }

    [LoggerMessage(EventId = 5101, Level = LogLevel.Warning, Message = "Device Node is disabled because its identity is not configured.")]
    private static partial void LogIdentityNotConfigured(ILogger logger);

    [LoggerMessage(EventId = 5102, Level = LogLevel.Error, Message = "Device Node loop failed; retrying after a bounded delay.")]
    private static partial void LogWorkerLoopFailure(ILogger logger, Exception exception);

    [LoggerMessage(EventId = 5103, Level = LogLevel.Error, Message = "Codex execution failed after recovery attempts for task {TaskId}.")]
    private static partial void LogExecutionFailure(ILogger logger, Exception exception, Guid taskId);

    [LoggerMessage(EventId = 5104, Level = LogLevel.Warning, Message = "Could not persist Device Node event {EventType} for task {TaskId}.")]
    private static partial void LogEventPersistenceFailure(ILogger logger, Exception exception, string eventType, Guid taskId);
}

public static class CodexApprovalResponseFactory
{
    public static object Create(
        string method,
        ApprovalDecisionValue decision,
        ApprovalScopeValue scope,
        JsonElement? requestParams = null,
        CapabilityPolicy? policy = null) => method switch
        {
            "item/commandExecution/requestApproval" => new CommandExecutionApprovalResponse(
                decision == ApprovalDecisionValue.Approve && AllowsCommand(requestParams, policy)
                    ? scope == ApprovalScopeValue.TaskSession ? "acceptForSession" : "accept"
                    : "cancel"),
            "item/fileChange/requestApproval" => new FileChangeApprovalResponse(
                decision == ApprovalDecisionValue.Approve && AllowsFileChange(requestParams, policy)
                    ? scope == ApprovalScopeValue.TaskSession ? "acceptForSession" : "accept"
                    : "cancel"),
            "item/permissions/requestApproval" => new PermissionsApprovalResponse(
                decision == ApprovalDecisionValue.Approve
                    ? GrantedPermissionProfile.FromRequest(requestParams, policy)
                    : GrantedPermissionProfile.Empty,
                scope == ApprovalScopeValue.TaskSession ? "session" : "turn"),
            _ => throw new ArgumentOutOfRangeException(nameof(method), method, "Unsupported Codex approval request.")
        };

    private static bool AllowsCommand(JsonElement? requestParams, CapabilityPolicy? policy)
    {
        if (policy?.RunCommands != true)
        {
            return false;
        }

        if (requestParams is not JsonElement value || value.ValueKind != JsonValueKind.Object)
        {
            return true;
        }

        if (value.TryGetProperty("cwd", out var cwd)
            && cwd.ValueKind == JsonValueKind.String
            && !policy.IsAllowedPath(cwd.GetString() ?? string.Empty, write: false))
        {
            return false;
        }

        var requestsNetwork = value.TryGetProperty("networkApprovalContext", out var networkContext)
                && networkContext.ValueKind is not (JsonValueKind.Null or JsonValueKind.Undefined)
            || value.TryGetProperty("proposedNetworkPolicyAmendments", out var amendments)
                && amendments.ValueKind == JsonValueKind.Array
                && amendments.GetArrayLength() > 0;
        return policy.Network || !requestsNetwork;
    }

    private static bool AllowsFileChange(JsonElement? requestParams, CapabilityPolicy? policy)
    {
        if (policy?.WriteFiles != true)
        {
            return false;
        }

        return requestParams is not JsonElement value
            || value.ValueKind != JsonValueKind.Object
            || !value.TryGetProperty("grantRoot", out var grantRoot)
            || grantRoot.ValueKind is JsonValueKind.Null or JsonValueKind.Undefined
            || grantRoot.ValueKind == JsonValueKind.String
                && policy.IsAllowedPath(grantRoot.GetString() ?? string.Empty, write: true);
    }
}

internal sealed class ActiveTurnState(string? threadId, string? turnId, bool startAttempted)
{
    public string? ThreadId { get; set; } = threadId;
    public string? TurnId { get; set; } = turnId;
    public bool StartAttempted { get; set; } = startAttempted;
}

public sealed class CodexTurnStartUncertainException(string threadId, Exception innerException) : Exception(
    $"Codex turn/start outcome is uncertain for thread '{threadId}'; refusing to replay the turn.", innerException)
{
    public string ThreadId { get; } = threadId;
}

public sealed record CommandExecutionApprovalResponse(string Decision);
public sealed record FileChangeApprovalResponse(object Decision);
public sealed record PermissionsApprovalResponse(GrantedPermissionProfile Permissions, string Scope);
public sealed record GrantedPermissionProfile(AdditionalFileSystemPermissions FileSystem, AdditionalNetworkPermissions Network)
{
    public static GrantedPermissionProfile Empty { get; } = new(
        new AdditionalFileSystemPermissions([], [], []),
        new AdditionalNetworkPermissions(false));

    public static GrantedPermissionProfile FromRequest(JsonElement? requestParams, CapabilityPolicy? policy)
    {
        if (requestParams is not JsonElement value
            || value.ValueKind != JsonValueKind.Object
            || policy is null
            || !value.TryGetProperty("permissions", out var requested)
            || requested.ValueKind != JsonValueKind.Object)
        {
            return Empty;
        }

        var entries = new List<FileSystemSandboxEntry>();
        var read = new List<string>();
        var write = new List<string>();
        if (requested.TryGetProperty("fileSystem", out var fileSystem)
            && fileSystem.ValueKind == JsonValueKind.Object)
        {
            if (fileSystem.TryGetProperty("entries", out var requestedEntries)
                && requestedEntries.ValueKind == JsonValueKind.Array)
            {
                foreach (var entry in requestedEntries.EnumerateArray())
                {
                    TryAddRequestedEntry(entry, policy, entries);
                }
            }

            AddLegacyPaths(fileSystem, "read", write: false, policy, entries, read);
            AddLegacyPaths(fileSystem, "write", write: true, policy, entries, write);
        }

        var networkEnabled = requested.TryGetProperty("network", out var network)
            && network.ValueKind == JsonValueKind.Object
            && network.TryGetProperty("enabled", out var enabled)
            && enabled.ValueKind == JsonValueKind.True
            && policy.Network;
        return new GrantedPermissionProfile(
            new AdditionalFileSystemPermissions(entries, read, write),
            new AdditionalNetworkPermissions(networkEnabled));
    }

    private static void AddLegacyPaths(
        JsonElement fileSystem,
        string propertyName,
        bool write,
        CapabilityPolicy policy,
        List<FileSystemSandboxEntry> entries,
        List<string> legacyPaths)
    {
        if (!fileSystem.TryGetProperty(propertyName, out var paths) || paths.ValueKind != JsonValueKind.Array)
        {
            return;
        }

        foreach (var value in paths.EnumerateArray())
        {
            if (value.ValueKind != JsonValueKind.String || !TryCanonicalAllowedPath(policy, value.GetString(), write, out var path))
            {
                continue;
            }

            if (!legacyPaths.Contains(path, StringComparer.Ordinal))
            {
                legacyPaths.Add(path);
            }

            entries.Add(new FileSystemSandboxEntry(write ? "write" : "read", new FileSystemPath("path", path)));
        }
    }

    private static void TryAddRequestedEntry(JsonElement entry, CapabilityPolicy policy, List<FileSystemSandboxEntry> accepted)
    {
        if (entry.ValueKind != JsonValueKind.Object
            || !entry.TryGetProperty("access", out var access)
            || access.ValueKind != JsonValueKind.String
            || (access.GetString() is not ("read" or "write")))
        {
            return;
        }

        var write = string.Equals(access.GetString(), "write", StringComparison.Ordinal);
        if (!entry.TryGetProperty("path", out var path)
            || path.ValueKind != JsonValueKind.Object
            || !path.TryGetProperty("type", out var type)
            || type.ValueKind != JsonValueKind.String
            || !string.Equals(type.GetString(), "path", StringComparison.Ordinal)
            || !path.TryGetProperty("path", out var rawPath)
            || rawPath.ValueKind != JsonValueKind.String
            || !TryCanonicalAllowedPath(policy, rawPath.GetString(), write, out var canonical))
        {
            return;
        }

        accepted.Add(new FileSystemSandboxEntry(access.GetString()!, new FileSystemPath("path", canonical)));
    }

    private static bool TryCanonicalAllowedPath(CapabilityPolicy policy, string? path, bool write, out string canonical)
    {
        canonical = string.Empty;
        return path is not null
            && CapabilityPolicy.TryGetCanonicalPath(path, out canonical)
            && policy.IsAllowedPath(canonical, write);
    }
}

public sealed record AdditionalFileSystemPermissions(
    IReadOnlyList<FileSystemSandboxEntry> Entries,
    IReadOnlyList<string> Read,
    IReadOnlyList<string> Write);
public sealed record FileSystemSandboxEntry(string Access, FileSystemPath Path);
public sealed record FileSystemPath(string Type, string Path);
public sealed record AdditionalNetworkPermissions(bool Enabled);
