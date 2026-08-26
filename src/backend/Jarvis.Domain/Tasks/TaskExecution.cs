namespace Jarvis.Domain.Tasks;

public enum TaskExecutionStatus
{
    Assigned,
    Running,
    WaitingForApproval,
    Recovering,
    Succeeded,
    Failed,
    Cancelled
}

public sealed class TaskExecution
{
    private TaskExecution()
    {
    }

    private TaskExecution(Guid id, Guid taskId, Guid deviceId, WorkerKind workerKind, long startedAtMs)
    {
        Id = id;
        TaskId = taskId;
        DeviceId = deviceId;
        WorkerKind = workerKind;
        Status = TaskExecutionStatus.Assigned;
        StartedAtMs = startedAtMs;
    }

    public Guid Id { get; private set; }

    public Guid TaskId { get; private set; }

    public Guid? DeviceId { get; private set; }

    public WorkerKind WorkerKind { get; private set; }

    public string? ExternalExecutionId { get; private set; }

    public string? CodexThreadId { get; private set; }

    public string? CodexTurnId { get; private set; }

    public long? CodexTurnStartRequestedAtMs { get; private set; }

    public TaskExecutionStatus Status { get; private set; }

    public long StartedAtMs { get; private set; }

    public long? EndedAtMs { get; private set; }

    public string MetadataJson { get; private set; } = "{}";

    public string? ResultPayloadJson { get; private set; }

    public string ArtifactManifestJson { get; private set; } = "[]";

    public long Version { get; private set; }

    public static TaskExecution Create(
        Guid id,
        Guid taskId,
        Guid deviceId,
        WorkerKind workerKind,
        long startedAtMs)
    {
        ArgumentOutOfRangeException.ThrowIfEqual(id, Guid.Empty);
        ArgumentOutOfRangeException.ThrowIfEqual(taskId, Guid.Empty);
        ArgumentOutOfRangeException.ThrowIfEqual(deviceId, Guid.Empty);
        ArgumentOutOfRangeException.ThrowIfNegative(startedAtMs);
        return new TaskExecution(id, taskId, deviceId, workerKind, startedAtMs);
    }

    public bool Start(long nowMs)
    {
        if (Status == TaskExecutionStatus.Running)
        {
            return false;
        }

        if (Status != TaskExecutionStatus.Assigned)
        {
            throw new InvalidOperationException($"Execution in {Status} cannot start.");
        }

        Status = TaskExecutionStatus.Running;
        StartedAtMs = Math.Min(StartedAtMs, nowMs);
        Version++;
        return true;
    }

    public bool SetCodexTurn(string threadId, string turnId)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(threadId);
        ArgumentException.ThrowIfNullOrWhiteSpace(turnId);
        if (Status is TaskExecutionStatus.Succeeded or TaskExecutionStatus.Failed or TaskExecutionStatus.Cancelled)
        {
            return false;
        }

        var normalizedThreadId = threadId.Trim();
        if (CodexThreadId is not null && !string.Equals(CodexThreadId, normalizedThreadId, StringComparison.Ordinal))
        {
            throw new InvalidOperationException("An execution cannot switch to a different Codex thread.");
        }

        CodexThreadId = normalizedThreadId;
        CodexTurnId = turnId.Trim();
        Version++;
        return true;
    }

    public bool MarkCodexTurnStarting(string threadId, long nowMs)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(threadId);
        ArgumentOutOfRangeException.ThrowIfNegative(nowMs);
        EnsureActive();
        var normalizedThreadId = threadId.Trim();
        if (CodexThreadId is not null && !string.Equals(CodexThreadId, normalizedThreadId, StringComparison.Ordinal))
        {
            throw new InvalidOperationException("An execution cannot switch to a different Codex thread.");
        }

        if (CodexTurnId is not null || CodexTurnStartRequestedAtMs is not null)
        {
            return false;
        }

        CodexThreadId = normalizedThreadId;
        CodexTurnStartRequestedAtMs = nowMs;
        Version++;
        return true;
    }

    public bool SetMetadata(string metadataJson)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(metadataJson);
        EnsureActive();
        if (string.Equals(MetadataJson, metadataJson, StringComparison.Ordinal))
        {
            return false;
        }

        MetadataJson = metadataJson;
        Version++;
        return true;
    }

    public bool WaitForApproval(long nowMs)
    {
        EnsureActive();
        Status = TaskExecutionStatus.WaitingForApproval;
        Version++;
        return true;
    }

    public bool Resume(long nowMs)
    {
        if (Status != TaskExecutionStatus.WaitingForApproval)
        {
            throw new InvalidOperationException($"Execution in {Status} cannot resume.");
        }

        Status = TaskExecutionStatus.Running;
        Version++;
        return true;
    }

    public bool MarkRecovering(long nowMs)
    {
        if (Status is TaskExecutionStatus.Succeeded or TaskExecutionStatus.Failed or TaskExecutionStatus.Cancelled)
        {
            return false;
        }

        Status = TaskExecutionStatus.Recovering;
        Version++;
        return true;
    }

    public bool ResumeFromRecovery(long nowMs)
    {
        if (Status != TaskExecutionStatus.Recovering)
        {
            throw new InvalidOperationException($"Execution in {Status} cannot resume from recovery.");
        }

        Status = TaskExecutionStatus.Running;
        Version++;
        return true;
    }

    public bool MarkSucceeded(string? resultPayloadJson, string artifactManifestJson, long nowMs)
    {
        EnsureActive();
        ArgumentException.ThrowIfNullOrWhiteSpace(artifactManifestJson);
        Status = TaskExecutionStatus.Succeeded;
        ResultPayloadJson = resultPayloadJson;
        ArtifactManifestJson = artifactManifestJson;
        EndedAtMs = nowMs;
        Version++;
        return true;
    }

    public bool MarkFailed(string metadataJson, long nowMs)
    {
        EnsureActive();
        ArgumentException.ThrowIfNullOrWhiteSpace(metadataJson);
        Status = TaskExecutionStatus.Failed;
        MetadataJson = metadataJson;
        EndedAtMs = nowMs;
        Version++;
        return true;
    }

    public bool MarkCancelled(long nowMs)
    {
        EnsureActive();
        Status = TaskExecutionStatus.Cancelled;
        EndedAtMs = nowMs;
        Version++;
        return true;
    }

    private void EnsureActive()
    {
        if (Status is TaskExecutionStatus.Succeeded or TaskExecutionStatus.Failed or TaskExecutionStatus.Cancelled)
        {
            throw new InvalidOperationException("A terminal execution cannot change state.");
        }
    }
}
