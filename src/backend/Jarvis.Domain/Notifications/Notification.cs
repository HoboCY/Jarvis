namespace Jarvis.Domain.Notifications;

public enum NotificationSeverity
{
    Info,
    Success,
    Warning,
    Error
}

public enum NotificationStatus
{
    Pending,
    Delivered,
    Read,
    Actioned,
    Dismissed
}

public sealed class Notification
{
    private Notification()
    {
    }

    private Notification(
        Guid id,
        Guid userId,
        Guid? conversationId,
        Guid? taskId,
        string type,
        NotificationSeverity severity,
        string title,
        string body,
        string dedupKey,
        long nowMs,
        Guid? approvalId)
    {
        Id = id;
        UserId = userId;
        ConversationId = conversationId;
        TaskId = taskId;
        ApprovalId = approvalId;
        Type = type;
        Severity = severity;
        Title = title;
        Body = body;
        DedupKey = dedupKey;
        ActionsJson = "[]";
        Status = NotificationStatus.Pending;
        CreatedAtMs = nowMs;
    }

    public Guid Id { get; private set; }

    public Guid UserId { get; private set; }

    public Guid? ConversationId { get; private set; }

    public Guid? TaskId { get; private set; }

    public Guid? ApprovalId { get; private set; }

    public string Type { get; private set; } = string.Empty;

    public NotificationSeverity Severity { get; private set; }

    public string Title { get; private set; } = string.Empty;

    public string Body { get; private set; } = string.Empty;

    public string ActionsJson { get; private set; } = "[]";

    public string DedupKey { get; private set; } = string.Empty;

    public NotificationStatus Status { get; private set; }

    public long CreatedAtMs { get; private set; }

    public long? DeliveredAtMs { get; private set; }

    public long? ReadAtMs { get; private set; }

    public long? ActionedAtMs { get; private set; }

    public long? ExpiresAtMs { get; private set; }

    public long Version { get; private set; }

    public static Notification Create(
        Guid id,
        Guid userId,
        Guid? conversationId,
        Guid? taskId,
        string type,
        NotificationSeverity severity,
        string title,
        string body,
        string dedupKey,
        long nowMs,
        Guid? approvalId = null)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(type);
        ArgumentException.ThrowIfNullOrWhiteSpace(title);
        ArgumentException.ThrowIfNullOrWhiteSpace(body);
        ArgumentException.ThrowIfNullOrWhiteSpace(dedupKey);
        return new Notification(
            id,
            userId,
            conversationId,
            taskId,
            type.Trim(),
            severity,
            title.Trim(),
            body.Trim(),
            dedupKey.Trim(),
            nowMs,
            approvalId);
    }

    public bool MarkDelivered(long nowMs)
    {
        EnsureNotTerminal();
        if (Status != NotificationStatus.Pending)
        {
            return false;
        }

        Status = NotificationStatus.Delivered;
        DeliveredAtMs = nowMs;
        Version++;
        return true;
    }

    public bool MarkRead(long nowMs)
    {
        EnsureNotTerminal();
        if (Status is NotificationStatus.Read)
        {
            return false;
        }

        if (Status is not (NotificationStatus.Pending or NotificationStatus.Delivered))
        {
            throw new InvalidOperationException($"A notification in {Status} cannot be read.");
        }

        Status = NotificationStatus.Read;
        ReadAtMs = nowMs;
        Version++;
        return true;
    }

    public bool MarkActioned(long nowMs)
    {
        EnsureNotTerminal();
        if (Status == NotificationStatus.Actioned)
        {
            return false;
        }

        if (Status is not (NotificationStatus.Pending or NotificationStatus.Delivered or NotificationStatus.Read))
        {
            throw new InvalidOperationException($"A notification in {Status} cannot be actioned.");
        }

        Status = NotificationStatus.Actioned;
        ActionedAtMs = nowMs;
        Version++;
        return true;
    }

    public bool MarkDismissed(long nowMs)
    {
        EnsureNotTerminal();
        if (Status == NotificationStatus.Dismissed)
        {
            return false;
        }

        if (Status is not (NotificationStatus.Pending or NotificationStatus.Delivered or NotificationStatus.Read))
        {
            throw new InvalidOperationException($"A notification in {Status} cannot be dismissed.");
        }

        Status = NotificationStatus.Dismissed;
        Version++;
        return true;
    }

    private void EnsureNotTerminal()
    {
        if (Status is NotificationStatus.Actioned or NotificationStatus.Dismissed)
        {
            throw new InvalidOperationException("A terminal notification cannot change state.");
        }
    }
}
