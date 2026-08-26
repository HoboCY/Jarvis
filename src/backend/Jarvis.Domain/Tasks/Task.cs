namespace Jarvis.Domain.Tasks;

public enum TaskStatus
{
    Queued,
    Assigned,
    Running,
    WaitingForApproval,
    WaitingForUserInput,
    CancellationRequested,
    Recovering,
    Succeeded,
    Failed,
    Cancelled
}

public enum WorkerKind
{
    Internal,
    Responses,
    Codex
}

public sealed class Task
{
    private Task()
    {
    }

    private Task(
        Guid id,
        Guid userId,
        Guid conversationId,
        Guid? createdByMessageId,
        string goal,
        string? expectedOutput,
        string requiredCapabilitiesJson,
        string attachmentRefsJson,
        string capabilityEnvelopeJson,
        Guid? preferredDeviceId,
        WorkerKind workerKind,
        int priority,
        long nowMs)
    {
        Id = id;
        UserId = userId;
        ConversationId = conversationId;
        CreatedByMessageId = createdByMessageId;
        Goal = goal;
        ExpectedOutput = expectedOutput;
        RequiredCapabilitiesJson = requiredCapabilitiesJson;
        AttachmentRefsJson = attachmentRefsJson;
        CapabilityEnvelopeJson = capabilityEnvelopeJson;
        PreferredDeviceId = preferredDeviceId;
        WorkerKind = workerKind;
        Status = TaskStatus.Queued;
        Priority = priority;
        MaxAttempts = 3;
        CreatedAtMs = nowMs;
    }

    public Guid Id { get; private set; }

    public Guid UserId { get; private set; }

    public Guid ConversationId { get; private set; }

    public Guid? CreatedByMessageId { get; private set; }

    public string Goal { get; private set; } = string.Empty;

    public string? ExpectedOutput { get; private set; }

    public string RequiredCapabilitiesJson { get; private set; } = "[]";

    public string AttachmentRefsJson { get; private set; } = "[]";

    public string CapabilityEnvelopeJson { get; private set; } = "{}";

    public Guid? PreferredDeviceId { get; private set; }

    public Guid? AssignedDeviceId { get; private set; }

    public WorkerKind WorkerKind { get; private set; }

    public TaskStatus Status { get; private set; }

    public int Priority { get; private set; }

    public int Attempt { get; private set; }

    public int MaxAttempts { get; private set; }

    public string? LeaseOwner { get; private set; }

    public long? LeaseExpiresAtMs { get; private set; }

    public long? HeartbeatAtMs { get; private set; }

    public string? ProgressSummary { get; private set; }

    public string? ResultSummary { get; private set; }

    public string? ResultPayloadJson { get; private set; }

    public string? ErrorCode { get; private set; }

    public string? ErrorMessage { get; private set; }

    public long CreatedAtMs { get; private set; }

    public long? StartedAtMs { get; private set; }

    public long? CompletedAtMs { get; private set; }

    public long Version { get; private set; }

    public static Task Create(
        Guid id,
        Guid userId,
        Guid conversationId,
        string goal,
        string? expectedOutput,
        string requiredCapabilitiesJson,
        string attachmentRefsJson,
        Guid? preferredDeviceId,
        WorkerKind workerKind,
        int priority,
        long nowMs,
        Guid? createdByMessageId = null,
        string capabilityEnvelopeJson = "{}")
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(goal);
        ArgumentException.ThrowIfNullOrWhiteSpace(requiredCapabilitiesJson);
        ArgumentException.ThrowIfNullOrWhiteSpace(attachmentRefsJson);
        ArgumentException.ThrowIfNullOrWhiteSpace(capabilityEnvelopeJson);
        ArgumentOutOfRangeException.ThrowIfNegative(priority);
        ArgumentOutOfRangeException.ThrowIfNegative(nowMs);

        return new Task(
            id,
            userId,
            conversationId,
            createdByMessageId,
            goal.Trim(),
            string.IsNullOrWhiteSpace(expectedOutput) ? null : expectedOutput.Trim(),
            requiredCapabilitiesJson,
            attachmentRefsJson,
            capabilityEnvelopeJson,
            preferredDeviceId,
            workerKind,
            priority,
            nowMs);
    }

    public bool Assign(string leaseOwner, long leaseExpiresAtMs, long nowMs, Guid? deviceId = null)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(leaseOwner);
        ArgumentOutOfRangeException.ThrowIfNegative(leaseExpiresAtMs);
        EnsureNotTerminal();
        if (Status is TaskStatus.Assigned)
        {
            return false;
        }

        if (Status is not (TaskStatus.Queued or TaskStatus.Recovering))
        {
            throw new InvalidOperationException($"A task in {Status} cannot be assigned.");
        }

        Status = TaskStatus.Assigned;
        LeaseOwner = leaseOwner.Trim();
        LeaseExpiresAtMs = leaseExpiresAtMs;
        HeartbeatAtMs = nowMs;
        AssignedDeviceId = deviceId ?? PreferredDeviceId;
        Attempt++;
        Touch();
        return true;
    }

    public bool Start(long nowMs)
    {
        EnsureNotTerminal();
        if (Status == TaskStatus.Running)
        {
            return false;
        }

        if (Status != TaskStatus.Assigned)
        {
            throw new InvalidOperationException($"A task in {Status} cannot start.");
        }

        Status = TaskStatus.Running;
        StartedAtMs ??= nowMs;
        HeartbeatAtMs = nowMs;
        Touch();
        return true;
    }

    public bool MarkProgress(string? progressSummary, long nowMs)
    {
        if (Status != TaskStatus.Running)
        {
            throw new InvalidOperationException($"A task in {Status} cannot receive progress.");
        }

        var changed = !string.Equals(ProgressSummary, progressSummary, StringComparison.Ordinal)
            || HeartbeatAtMs != nowMs;
        ProgressSummary = string.IsNullOrWhiteSpace(progressSummary) ? null : progressSummary.Trim();
        HeartbeatAtMs = nowMs;
        if (changed)
        {
            Touch();
        }

        return changed;
    }

    public bool RenewLease(string leaseOwner, long leaseExpiresAtMs, long nowMs)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(leaseOwner);
        ArgumentOutOfRangeException.ThrowIfNegative(leaseExpiresAtMs);
        ArgumentOutOfRangeException.ThrowIfNegative(nowMs);
        if (Status is not (TaskStatus.Running or TaskStatus.WaitingForApproval)
            || !string.Equals(LeaseOwner, leaseOwner.Trim(), StringComparison.Ordinal)
            || LeaseExpiresAtMs is not long currentLeaseExpiresAtMs
            || currentLeaseExpiresAtMs <= nowMs)
        {
            return false;
        }

        LeaseExpiresAtMs = leaseExpiresAtMs;
        HeartbeatAtMs = nowMs;
        Touch();
        return true;
    }

    public bool RequestCancellation(long nowMs)
    {
        if (Status is TaskStatus.Succeeded or TaskStatus.Failed or TaskStatus.Cancelled)
        {
            return false;
        }

        if (Status == TaskStatus.CancellationRequested)
        {
            return false;
        }

        if (Status == TaskStatus.Queued)
        {
            Status = TaskStatus.Cancelled;
            CompletedAtMs = nowMs;
            Touch();
            return true;
        }

        if (Status != TaskStatus.Running)
        {
            throw new InvalidOperationException($"A task in {Status} cannot request cancellation.");
        }

        Status = TaskStatus.CancellationRequested;
        Touch();
        return true;
    }

    public bool ConfirmCancellation(long nowMs)
    {
        if (Status == TaskStatus.Cancelled)
        {
            return false;
        }

        if (Status != TaskStatus.CancellationRequested)
        {
            throw new InvalidOperationException($"A task in {Status} has no pending cancellation.");
        }

        Status = TaskStatus.Cancelled;
        CompletedAtMs = nowMs;
        LeaseOwner = null;
        LeaseExpiresAtMs = null;
        HeartbeatAtMs = nowMs;
        Touch();
        return true;
    }

    public bool MarkSucceeded(string resultSummary, long nowMs, string? resultPayloadJson = null)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(resultSummary);
        EnsureCanSucceed();
        Status = TaskStatus.Succeeded;
        ResultSummary = resultSummary.Trim();
        ResultPayloadJson = resultPayloadJson;
        CompletedAtMs = nowMs;
        LeaseOwner = null;
        LeaseExpiresAtMs = null;
        HeartbeatAtMs = nowMs;
        Touch();
        return true;
    }

    public bool MarkFailed(string errorCode, string errorMessage, long nowMs)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(errorCode);
        ArgumentException.ThrowIfNullOrWhiteSpace(errorMessage);
        EnsureCanFail();
        Status = TaskStatus.Failed;
        ErrorCode = errorCode.Trim();
        ErrorMessage = errorMessage.Trim();
        CompletedAtMs = nowMs;
        LeaseOwner = null;
        LeaseExpiresAtMs = null;
        HeartbeatAtMs = nowMs;
        Touch();
        return true;
    }

    public bool MarkApprovalFailed(string errorCode, string errorMessage, long nowMs)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(errorCode);
        ArgumentException.ThrowIfNullOrWhiteSpace(errorMessage);
        if (Status != TaskStatus.WaitingForApproval)
        {
            throw new InvalidOperationException($"A task in {Status} has no pending approval to fail.");
        }

        Status = TaskStatus.Failed;
        ErrorCode = errorCode.Trim();
        ErrorMessage = errorMessage.Trim();
        CompletedAtMs = nowMs;
        LeaseOwner = null;
        LeaseExpiresAtMs = null;
        HeartbeatAtMs = nowMs;
        Touch();
        return true;
    }

    public bool MarkRecovering(long nowMs, bool preserveLease = false)
    {
        if (Status == TaskStatus.Recovering)
        {
            return false;
        }

        if (Status is not (TaskStatus.Assigned or TaskStatus.Running or TaskStatus.WaitingForApproval))
        {
            throw new InvalidOperationException($"A task in {Status} cannot recover.");
        }

        Status = TaskStatus.Recovering;
        if (!preserveLease)
        {
            LeaseOwner = null;
            LeaseExpiresAtMs = null;
        }
        HeartbeatAtMs = nowMs;
        Touch();
        return true;
    }

    public bool ResumeFromRecovery(long nowMs)
    {
        if (Status != TaskStatus.Recovering)
        {
            throw new InvalidOperationException($"A task in {Status} cannot resume from recovery.");
        }

        Status = TaskStatus.Running;
        HeartbeatAtMs = nowMs;
        Touch();
        return true;
    }

    public bool WaitForApproval(long nowMs)
    {
        EnsureCanPause();
        Status = TaskStatus.WaitingForApproval;
        Touch();
        HeartbeatAtMs = nowMs;
        return true;
    }

    public bool WaitForUserInput(long nowMs)
    {
        EnsureCanPause();
        Status = TaskStatus.WaitingForUserInput;
        Touch();
        HeartbeatAtMs = nowMs;
        return true;
    }

    public bool Resume(long nowMs)
    {
        if (Status is not (TaskStatus.WaitingForApproval or TaskStatus.WaitingForUserInput))
        {
            throw new InvalidOperationException($"A task in {Status} cannot resume.");
        }

        Status = TaskStatus.Running;
        HeartbeatAtMs = nowMs;
        Touch();
        return true;
    }

    private void EnsureNotTerminal()
    {
        if (Status is TaskStatus.Succeeded or TaskStatus.Failed or TaskStatus.Cancelled)
        {
            throw new InvalidOperationException("A terminal task cannot change state.");
        }
    }

    private void EnsureCanSucceed()
    {
        if (Status is TaskStatus.Succeeded or TaskStatus.Failed or TaskStatus.Cancelled)
        {
            throw new InvalidOperationException("A terminal task cannot change state.");
        }

        if (Status != TaskStatus.Running)
        {
            throw new InvalidOperationException($"A task in {Status} cannot succeed.");
        }
    }

    private void EnsureCanFail()
    {
        if (Status is TaskStatus.Succeeded or TaskStatus.Failed or TaskStatus.Cancelled)
        {
            throw new InvalidOperationException("A terminal task cannot change state.");
        }

        if (Status is not (TaskStatus.Running or TaskStatus.Recovering))
        {
            throw new InvalidOperationException($"A task in {Status} cannot fail.");
        }
    }

    private void EnsureCanPause()
    {
        EnsureNotTerminal();
        if (Status != TaskStatus.Running)
        {
            throw new InvalidOperationException($"A task in {Status} cannot pause.");
        }
    }

    private void Touch() => Version++;
}
