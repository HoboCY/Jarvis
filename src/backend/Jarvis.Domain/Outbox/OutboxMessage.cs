namespace Jarvis.Domain.Outbox;

public sealed class OutboxMessage
{
    private OutboxMessage()
    {
    }

    private OutboxMessage(Guid id, string eventType, string payloadJson, long nowMs)
    {
        Id = id;
        EventType = eventType;
        PayloadJson = payloadJson;
        CreatedAtMs = nowMs;
        AttemptCount = 0;
    }

    public Guid Id { get; private set; }

    public string EventType { get; private set; } = string.Empty;

    public string PayloadJson { get; private set; } = string.Empty;

    public long CreatedAtMs { get; private set; }

    public long? PublishedAtMs { get; private set; }

    public int AttemptCount { get; private set; }

    public long? NextAttemptAtMs { get; private set; }

    public Guid? ClaimedBy { get; private set; }

    public long? ClaimedUntilMs { get; private set; }

    public string? LastError { get; private set; }

    public long Version { get; private set; }

    public static OutboxMessage Create(Guid id, string eventType, string payloadJson, long nowMs)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(eventType);
        ArgumentException.ThrowIfNullOrWhiteSpace(payloadJson);

        return new OutboxMessage(id, eventType.Trim(), payloadJson, nowMs);
    }

    public void Claim(Guid leaseId, long claimedUntilMs)
    {
        ClaimedBy = leaseId;
        ClaimedUntilMs = claimedUntilMs;
    }

    public bool IsClaimedBy(Guid leaseId) => ClaimedBy == leaseId;

    public void MarkPublished(long publishedAtMs, Guid leaseId)
    {
        if (!IsClaimedBy(leaseId))
        {
            return;
        }

        PublishedAtMs = publishedAtMs;
        LastError = null;
        NextAttemptAtMs = null;
        ClaimedBy = null;
        ClaimedUntilMs = null;
    }

    public void MarkFailed(string error, long nextAttemptAtMs, Guid leaseId)
    {
        if (!IsClaimedBy(leaseId))
        {
            return;
        }

        AttemptCount++;
        LastError = error.Length > 2_000 ? error[..2_000] : error;
        NextAttemptAtMs = nextAttemptAtMs;
        ClaimedBy = null;
        ClaimedUntilMs = null;
    }
}
