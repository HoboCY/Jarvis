namespace Jarvis.Domain.Memory;

public enum MemoryFactStatus
{
    Active,
    Retracted
}

/// <summary>
/// A user-owned, explicitly confirmed key/value fact. The value is kept as JSON so
/// the application boundary can evolve its wire representation without leaking a
/// provider DTO into the domain.
/// </summary>
public sealed class MemoryFact
{
    private MemoryFact()
    {
    }

    private MemoryFact(
        Guid id,
        Guid userId,
        string key,
        string valueJson,
        Guid? sourceMessageId,
        double confidence,
        bool sensitive,
        Guid? supersedesMemoryId,
        long nowMs)
    {
        Id = id;
        UserId = userId;
        Key = key;
        ValueJson = valueJson;
        SourceMessageId = sourceMessageId;
        Confidence = confidence;
        Sensitive = sensitive;
        Status = MemoryFactStatus.Active;
        SupersedesMemoryId = supersedesMemoryId;
        LastConfirmedAtMs = nowMs;
        CreatedAtMs = nowMs;
        UpdatedAtMs = nowMs;
    }

    public Guid Id { get; private set; }

    public Guid UserId { get; private set; }

    public string Key { get; private set; } = string.Empty;

    public string ValueJson { get; private set; } = string.Empty;

    public Guid? SourceMessageId { get; private set; }

    public double Confidence { get; private set; }

    public bool Sensitive { get; private set; }

    public MemoryFactStatus Status { get; private set; }

    public Guid? SupersedesMemoryId { get; private set; }

    public long? LastConfirmedAtMs { get; private set; }

    public long CreatedAtMs { get; private set; }

    public long UpdatedAtMs { get; private set; }

    public long Version { get; private set; }

    public static MemoryFact CreateDirect(
        Guid id,
        Guid userId,
        string key,
        string valueJson,
        Guid? sourceMessageId,
        bool sensitive,
        long nowMs,
        Guid? supersedesMemoryId = null)
    {
        ArgumentOutOfRangeException.ThrowIfEqual(id, Guid.Empty);
        ArgumentOutOfRangeException.ThrowIfEqual(userId, Guid.Empty);
        ArgumentException.ThrowIfNullOrWhiteSpace(key);
        ArgumentException.ThrowIfNullOrWhiteSpace(valueJson);
        ArgumentOutOfRangeException.ThrowIfNegative(nowMs);
        return new MemoryFact(
            id,
            userId,
            key.Trim(),
            valueJson,
            sourceMessageId,
            confidence: 1d,
            sensitive,
            supersedesMemoryId,
            nowMs);
    }

    public static MemoryFact Create(
        Guid id,
        Guid userId,
        string key,
        string valueJson,
        Guid? sourceMessageId,
        double confidence,
        bool sensitive,
        long nowMs,
        Guid? supersedesMemoryId = null)
    {
        ArgumentOutOfRangeException.ThrowIfEqual(id, Guid.Empty);
        ArgumentOutOfRangeException.ThrowIfEqual(userId, Guid.Empty);
        ArgumentException.ThrowIfNullOrWhiteSpace(key);
        ArgumentException.ThrowIfNullOrWhiteSpace(valueJson);
        ArgumentOutOfRangeException.ThrowIfNegative(nowMs);
        if (double.IsNaN(confidence) || double.IsInfinity(confidence) || confidence is < 0 or > 1)
        {
            throw new ArgumentOutOfRangeException(nameof(confidence));
        }

        return new MemoryFact(
            id,
            userId,
            key.Trim(),
            valueJson,
            sourceMessageId,
            confidence,
            sensitive,
            supersedesMemoryId,
            nowMs);
    }

    public bool Retract(long nowMs)
    {
        ArgumentOutOfRangeException.ThrowIfNegative(nowMs);
        if (Status == MemoryFactStatus.Retracted)
        {
            return false;
        }

        Status = MemoryFactStatus.Retracted;
        UpdatedAtMs = nowMs;
        Version++;
        return true;
    }
}
