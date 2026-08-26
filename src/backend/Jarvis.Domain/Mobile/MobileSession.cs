namespace Jarvis.Domain.Mobile;

/// <summary>
/// Durable mobile session state. Access tokens are process-local and are never
/// persisted; only the current refresh-token hash is stored here.
/// </summary>
public sealed class MobileSession
{
    private MobileSession()
    {
    }

    private MobileSession(
        Guid id,
        Guid userId,
        Guid deviceId,
        string refreshTokenHash,
        long createdAtMs,
        long refreshTokenExpiresAtMs)
    {
        Id = id;
        UserId = userId;
        DeviceId = deviceId;
        RefreshTokenHash = refreshTokenHash;
        CreatedAtMs = createdAtMs;
        RefreshTokenExpiresAtMs = refreshTokenExpiresAtMs;
    }

    public Guid Id { get; private set; }

    public Guid UserId { get; private set; }

    public Guid DeviceId { get; private set; }

    public string RefreshTokenHash { get; private set; } = string.Empty;

    public long CreatedAtMs { get; private set; }

    public long LastRefreshedAtMs { get; private set; }

    public long RefreshTokenExpiresAtMs { get; private set; }

    public long? RevokedAtMs { get; private set; }

    public long Version { get; private set; }

    public bool IsRevoked => RevokedAtMs is not null;

    public static MobileSession Create(
        Guid id,
        Guid userId,
        Guid deviceId,
        string refreshTokenHash,
        long createdAtMs,
        long refreshTokenExpiresAtMs)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(refreshTokenHash);
        ArgumentOutOfRangeException.ThrowIfNegative(createdAtMs);
        ArgumentOutOfRangeException.ThrowIfLessThanOrEqual(refreshTokenExpiresAtMs, createdAtMs);

        return new MobileSession(
            id,
            userId,
            deviceId,
            refreshTokenHash.Trim(),
            createdAtMs,
            refreshTokenExpiresAtMs);
    }

    public bool CanRefresh(long nowMs, ReadOnlySpan<byte> refreshTokenHash)
    {
        if (RevokedAtMs is not null || nowMs >= RefreshTokenExpiresAtMs)
        {
            return false;
        }

        try
        {
            var expected = Convert.FromHexString(RefreshTokenHash);
            return expected.Length == refreshTokenHash.Length
                && System.Security.Cryptography.CryptographicOperations.FixedTimeEquals(expected, refreshTokenHash);
        }
        catch (FormatException)
        {
            // A corrupt persisted hash must fail closed, not turn refresh into a 500.
            return false;
        }
    }

    public bool RotateRefreshToken(string refreshTokenHash, long nowMs, long refreshTokenExpiresAtMs)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(refreshTokenHash);
        if (RevokedAtMs is not null || nowMs >= RefreshTokenExpiresAtMs)
        {
            return false;
        }

        RefreshTokenHash = refreshTokenHash.Trim();
        LastRefreshedAtMs = nowMs;
        RefreshTokenExpiresAtMs = refreshTokenExpiresAtMs;
        Version++;
        return true;
    }

    public bool Revoke(long nowMs)
    {
        if (RevokedAtMs is not null)
        {
            return false;
        }

        RevokedAtMs = nowMs;
        Version++;
        return true;
    }
}
