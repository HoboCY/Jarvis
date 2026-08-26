namespace Jarvis.Domain.Mobile;

/// <summary>
/// A short-lived pairing invitation. Only the one-way hash of the code is
/// persisted; the code itself is returned to the trusted Desktop once.
/// </summary>
public sealed class MobilePairing
{
    private MobilePairing()
    {
    }

    private MobilePairing(
        Guid id,
        Guid userId,
        string codeHash,
        string deviceName,
        string platform,
        string capabilitiesJson,
        long createdAtMs,
        long expiresAtMs)
    {
        Id = id;
        UserId = userId;
        CodeHash = codeHash;
        DeviceName = deviceName;
        Platform = platform;
        CapabilitiesJson = capabilitiesJson;
        CreatedAtMs = createdAtMs;
        ExpiresAtMs = expiresAtMs;
    }

    public Guid Id { get; private set; }

    public Guid UserId { get; private set; }

    public string CodeHash { get; private set; } = string.Empty;

    public string DeviceName { get; private set; } = string.Empty;

    public string Platform { get; private set; } = string.Empty;

    public string CapabilitiesJson { get; private set; } = "[]";

    public long CreatedAtMs { get; private set; }

    public long ExpiresAtMs { get; private set; }

    public long? ConsumedAtMs { get; private set; }

    public long Version { get; private set; }

    public bool IsConsumed => ConsumedAtMs is not null;

    public static MobilePairing Create(
        Guid id,
        Guid userId,
        string codeHash,
        string deviceName,
        string platform,
        string capabilitiesJson,
        long createdAtMs,
        long expiresAtMs)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(codeHash);
        ArgumentException.ThrowIfNullOrWhiteSpace(deviceName);
        ArgumentException.ThrowIfNullOrWhiteSpace(platform);
        ArgumentException.ThrowIfNullOrWhiteSpace(capabilitiesJson);
        ArgumentOutOfRangeException.ThrowIfNegative(createdAtMs);
        ArgumentOutOfRangeException.ThrowIfLessThanOrEqual(expiresAtMs, createdAtMs);

        return new MobilePairing(
            id,
            userId,
            codeHash.Trim(),
            deviceName.Trim(),
            platform.Trim(),
            capabilitiesJson,
            createdAtMs,
            expiresAtMs);
    }

    public bool TryConsume(long nowMs)
    {
        if (ConsumedAtMs is not null || nowMs >= ExpiresAtMs)
        {
            return false;
        }

        ConsumedAtMs = nowMs;
        Version++;
        return true;
    }
}
