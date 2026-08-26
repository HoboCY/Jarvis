namespace Jarvis.Domain.Approvals;

public enum ApprovalKind
{
    Command,
    FileWrite,
    Permission,
    ExternalWrite
}

public enum ApprovalScope
{
    Once,
    TaskSession
}

public enum ApprovalStatus
{
    Pending,
    Approved,
    Denied,
    Expired,
    Cancelled
}

public enum ApprovalDecision
{
    Approved,
    Denied
}

public sealed class Approval
{
    private Approval()
    {
    }

    private Approval(
        Guid id,
        Guid taskId,
        Guid executionId,
        Guid deviceId,
        string? requestId,
        ApprovalKind kind,
        string reason,
        string requestedActionJson,
        ApprovalScope? scope,
        long createdAtMs,
        long? expiresAtMs)
    {
        Id = id;
        TaskId = taskId;
        ExecutionId = executionId;
        DeviceId = deviceId;
        RequestId = requestId;
        Kind = kind;
        Reason = reason;
        RequestedActionJson = requestedActionJson;
        // Scope is a property of the user's decision, never of a pending request.
        Scope = null;
        Status = ApprovalStatus.Pending;
        CreatedAtMs = createdAtMs;
        ExpiresAtMs = expiresAtMs;
    }

    public Guid Id { get; private set; }

    public Guid TaskId { get; private set; }

    public Guid? ExecutionId { get; private set; }

    public Guid DeviceId { get; private set; }

    /// <summary>Upstream JSON-RPC request identifier, when the request came from Codex.</summary>
    public string? RequestId { get; private set; }

    public ApprovalKind Kind { get; private set; }

    public string Reason { get; private set; } = string.Empty;

    public string RequestedActionJson { get; private set; } = "{}";

    public ApprovalStatus Status { get; private set; }

    public ApprovalScope? Scope { get; private set; }

    public Guid? DecidedByDeviceId { get; private set; }

    public ApprovalDecision? Decision { get; private set; }

    public long CreatedAtMs { get; private set; }

    public long? DecidedAtMs { get; private set; }

    public long? ExpiresAtMs { get; private set; }

    public long Version { get; private set; }

    public static Approval Create(
        Guid id,
        Guid taskId,
        Guid executionId,
        Guid deviceId,
        string? requestId,
        ApprovalKind kind,
        string reason,
        string requestedActionJson,
        ApprovalScope? scope,
        long createdAtMs,
        long? expiresAtMs)
    {
        ArgumentOutOfRangeException.ThrowIfEqual(id, Guid.Empty);
        ArgumentOutOfRangeException.ThrowIfEqual(taskId, Guid.Empty);
        ArgumentOutOfRangeException.ThrowIfEqual(executionId, Guid.Empty);
        ArgumentOutOfRangeException.ThrowIfEqual(deviceId, Guid.Empty);
        ArgumentException.ThrowIfNullOrWhiteSpace(reason);
        ArgumentException.ThrowIfNullOrWhiteSpace(requestedActionJson);
        ArgumentOutOfRangeException.ThrowIfNegative(createdAtMs);
        if (expiresAtMs is <= 0 || expiresAtMs <= createdAtMs)
        {
            throw new ArgumentOutOfRangeException(nameof(expiresAtMs));
        }

        return new Approval(
            id,
            taskId,
            executionId,
            deviceId,
            requestId,
            kind,
            reason.Trim(),
            requestedActionJson,
            scope,
            createdAtMs,
            expiresAtMs);
    }

    public bool Decide(ApprovalDecision decision, ApprovalScope scope, Guid decidedByDeviceId, long nowMs)
    {
        ArgumentOutOfRangeException.ThrowIfEqual(decidedByDeviceId, Guid.Empty);
        if (Status != ApprovalStatus.Pending || IsExpired(nowMs))
        {
            return false;
        }

        Status = decision == ApprovalDecision.Approved
            ? ApprovalStatus.Approved
            : ApprovalStatus.Denied;
        Decision = decision;
        Scope = scope;
        DecidedByDeviceId = decidedByDeviceId;
        DecidedAtMs = nowMs;
        Version++;
        return true;
    }

    public bool Decide(ApprovalDecision decision, Guid decidedByDeviceId, long nowMs) =>
        Decide(decision, Scope ?? ApprovalScope.Once, decidedByDeviceId, nowMs);

    public bool Expire(long nowMs)
    {
        if (Status != ApprovalStatus.Pending || !IsExpired(nowMs))
        {
            return false;
        }

        Status = ApprovalStatus.Expired;
        DecidedAtMs = nowMs;
        Version++;
        return true;
    }

    public bool Cancel(long nowMs)
    {
        if (Status != ApprovalStatus.Pending)
        {
            return false;
        }

        Status = ApprovalStatus.Cancelled;
        DecidedAtMs = nowMs;
        Version++;
        return true;
    }

    private bool IsExpired(long nowMs) => ExpiresAtMs is long expiresAtMs && expiresAtMs <= nowMs;
}
