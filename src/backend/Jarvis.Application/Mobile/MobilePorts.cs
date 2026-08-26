using System.Collections.Concurrent;
using System.Security.Cryptography;
using Jarvis.Contracts;

namespace Jarvis.Application.Mobile;

public enum MobileOperationStatus
{
    Succeeded,
    Conflict,
    Invalid,
    Unauthorized,
    NotFound,
    Unavailable
}

public sealed record MobileOperation<T>(
    MobileOperationStatus Status,
    T? Value = default,
    string? Detail = null);

public sealed record MobilePairingStoreResult(
    Guid PairingId,
    long ExpiresAtMs,
    bool Conflict = false,
    string? Detail = null);

public sealed record MobileSessionIdentity(
    Guid SessionId,
    Guid UserId,
    Guid DeviceId,
    long RefreshTokenExpiresAtMs);

public sealed record MobileSessionStoreResult(
    MobileSessionIdentity? Identity = null,
    bool Unauthorized = false,
    bool Conflict = false,
    string? Detail = null);

public interface IMobilePairingStore
{
    Task<MobilePairingStoreResult> CreatePairingAsync(
        Guid userId,
        MobilePairingRequest request,
        string idempotencyKey,
        string codeHash,
        long createdAtMs,
        long expiresAtMs,
        CancellationToken cancellationToken);

    Task<MobileSessionStoreResult> ExchangeAsync(
        MobilePairingExchangeRequest request,
        string codeHash,
        string deviceName,
        string platform,
        IReadOnlyList<string> capabilities,
        string refreshTokenHash,
        long nowMs,
        long refreshTokenExpiresAtMs,
        CancellationToken cancellationToken);

    Task<MobileSessionStoreResult> RotateRefreshTokenAsync(
        Guid sessionId,
        string refreshTokenHash,
        string replacementRefreshTokenHash,
        long nowMs,
        long refreshTokenExpiresAtMs,
        CancellationToken cancellationToken);

    Task<MobileOperation<MobileSessionRevokeResponse>> RevokeAsync(
        Guid userId,
        Guid sessionId,
        long nowMs,
        CancellationToken cancellationToken);
}

public sealed record MobileAccessToken(
    Guid UserId,
    Guid SessionId,
    Guid DeviceId,
    long ExpiresAtMs);

public interface IMobileAccessTokenStore
{
    (string Token, MobileAccessToken AccessToken) Issue(
        Guid userId,
        Guid sessionId,
        Guid deviceId,
        long nowMs,
        long lifetimeMs);

    bool TryGet(string token, long nowMs, out MobileAccessToken accessToken);

    void RevokeSession(Guid sessionId);
}

/// <summary>
/// Keeps mobile access tokens process-local. Only SHA-256 token hashes are held
/// in memory, and a process restart invalidates every access token.
/// </summary>
public sealed class InMemoryMobileAccessTokenStore : IMobileAccessTokenStore
{
    private readonly ConcurrentDictionary<string, Entry> entries = new(StringComparer.Ordinal);

    public (string Token, MobileAccessToken AccessToken) Issue(
        Guid userId,
        Guid sessionId,
        Guid deviceId,
        long nowMs,
        long lifetimeMs)
    {
        if (userId == Guid.Empty || sessionId == Guid.Empty || deviceId == Guid.Empty || lifetimeMs <= 0)
        {
            throw new ArgumentOutOfRangeException(nameof(lifetimeMs));
        }

        var token = $"jma_{Base64Url(RandomNumberGenerator.GetBytes(32))}";
        var accessToken = new MobileAccessToken(userId, sessionId, deviceId, checked(nowMs + lifetimeMs));
        var hash = SHA256.HashData(System.Text.Encoding.UTF8.GetBytes(token));
        entries[Convert.ToHexString(hash)] = new(hash, accessToken);
        return (token, accessToken);
    }

    public bool TryGet(string token, long nowMs, out MobileAccessToken accessToken)
    {
        accessToken = null!;
        if (string.IsNullOrWhiteSpace(token))
        {
            return false;
        }

        var hash = SHA256.HashData(System.Text.Encoding.UTF8.GetBytes(token));
        if (!entries.TryGetValue(Convert.ToHexString(hash), out var entry))
        {
            return false;
        }

        if (!CryptographicOperations.FixedTimeEquals(hash, entry.Hash)
            || entry.AccessToken.ExpiresAtMs <= nowMs)
        {
            entries.TryRemove(Convert.ToHexString(hash), out _);
            return false;
        }

        accessToken = entry.AccessToken;
        return true;
    }

    public void RevokeSession(Guid sessionId)
    {
        foreach (var pair in entries)
        {
            if (pair.Value.AccessToken.SessionId == sessionId)
            {
                entries.TryRemove(pair.Key, out _);
            }
        }
    }

    private static string Base64Url(ReadOnlySpan<byte> bytes) =>
        Convert.ToBase64String(bytes).TrimEnd('=').Replace('+', '-').Replace('/', '_');

    private sealed record Entry(byte[] Hash, MobileAccessToken AccessToken);
}

public sealed class MobileSessionService(
    IMobilePairingStore store,
    IMobileAccessTokenStore accessTokens,
    TimeProvider timeProvider,
    MobileSessionOptions options)
{
    public async Task<MobileOperation<MobilePairingResponse>> CreatePairingAsync(
        Guid userId,
        MobilePairingRequest? request,
        string? idempotencyKey,
        CancellationToken cancellationToken)
    {
        if (userId == Guid.Empty || request is null)
        {
            return Invalid<MobilePairingResponse>("A mobile pairing request is required.");
        }

        if (!TryNormalize(request, out var normalized, out var detail)
            || string.IsNullOrWhiteSpace(idempotencyKey)
            || idempotencyKey.Trim().Length > 200)
        {
            return Invalid<MobilePairingResponse>(detail ?? "The Idempotency-Key header is required.");
        }

        var nowMs = timeProvider.GetUtcNow().ToUnixTimeMilliseconds();
        var expiresAtMs = checked(nowMs + options.PairingLifetimeMs);
        var code = $"jpair_{Base64Url(RandomNumberGenerator.GetBytes(32))}";
        var result = await store.CreatePairingAsync(
            userId,
            normalized,
            idempotencyKey.Trim(),
            Hash(code),
            nowMs,
            expiresAtMs,
            cancellationToken);
        if (result.Conflict)
        {
            return new(MobileOperationStatus.Conflict, Detail: result.Detail);
        }

        return new(
            MobileOperationStatus.Succeeded,
            new MobilePairingResponse(result.PairingId, code, result.ExpiresAtMs));
    }

    public async Task<MobileOperation<MobileSessionResponse>> ExchangeAsync(
        MobilePairingExchangeRequest? request,
        CancellationToken cancellationToken)
    {
        if (request is null || string.IsNullOrWhiteSpace(request.Code) || request.Code.Trim().Length > 200)
        {
            return Unauthorized<MobileSessionResponse>();
        }

        var deviceName = request.DeviceName?.Trim();
        var platform = request.Platform?.Trim();
        if (deviceName is not null && (deviceName.Length is < 1 or > 200))
        {
            return Invalid<MobileSessionResponse>("deviceName is invalid.");
        }

        if (platform is not null && (platform.Length is < 1 or > 64))
        {
            return Invalid<MobileSessionResponse>("platform is invalid.");
        }

        var capabilities = NormalizeCapabilities(request.Capabilities);
        if (capabilities is null)
        {
            return Invalid<MobileSessionResponse>("capabilities is invalid.");
        }

        var nowMs = timeProvider.GetUtcNow().ToUnixTimeMilliseconds();
        var refreshToken = $"jrefresh_{Base64Url(RandomNumberGenerator.GetBytes(32))}";
        var result = await store.ExchangeAsync(
            request,
            Hash(request.Code.Trim()),
            deviceName ?? "Mobile",
            platform ?? "mobile",
            capabilities,
            Hash(refreshToken),
            nowMs,
            checked(nowMs + options.RefreshTokenLifetimeMs),
            cancellationToken);
        if (result.Identity is null)
        {
            return result.Conflict
                ? new(MobileOperationStatus.Conflict, Detail: result.Detail)
                : Unauthorized<MobileSessionResponse>();
        }

        return new(MobileOperationStatus.Succeeded, CreateSessionResponse(result.Identity, nowMs, refreshToken));
    }

    public async Task<MobileOperation<MobileSessionResponse>> RefreshAsync(
        MobileSessionRefreshRequest? request,
        CancellationToken cancellationToken)
    {
        if (request is null || request.SessionId == Guid.Empty || string.IsNullOrWhiteSpace(request.RefreshToken))
        {
            return Unauthorized<MobileSessionResponse>();
        }

        if (request.RefreshToken.Length > 300)
        {
            return Unauthorized<MobileSessionResponse>();
        }

        var nowMs = timeProvider.GetUtcNow().ToUnixTimeMilliseconds();
        var replacement = $"jrefresh_{Base64Url(RandomNumberGenerator.GetBytes(32))}";
        var result = await store.RotateRefreshTokenAsync(
            request.SessionId,
            Hash(request.RefreshToken),
            Hash(replacement),
            nowMs,
            checked(nowMs + options.RefreshTokenLifetimeMs),
            cancellationToken);
        if (result.Identity is null)
        {
            return Unauthorized<MobileSessionResponse>();
        }

        return new(MobileOperationStatus.Succeeded, CreateSessionResponse(result.Identity, nowMs, replacement));
    }

    public async Task<MobileOperation<MobileSessionRevokeResponse>> RevokeAsync(
        Guid userId,
        Guid sessionId,
        CancellationToken cancellationToken)
    {
        if (userId == Guid.Empty || sessionId == Guid.Empty)
        {
            return new(MobileOperationStatus.Unauthorized, Detail: "A mobile session is required.");
        }

        var result = await store.RevokeAsync(
            userId,
            sessionId,
            timeProvider.GetUtcNow().ToUnixTimeMilliseconds(),
            cancellationToken);
        if (result.Value is { } response && response.Revoked)
        {
            accessTokens.RevokeSession(sessionId);
            return result;
        }

        return result.Status switch
        {
            MobileOperationStatus.NotFound => new(MobileOperationStatus.NotFound),
            MobileOperationStatus.Unavailable => new(MobileOperationStatus.Unavailable, Detail: result.Detail),
            _ => new(MobileOperationStatus.Unauthorized, Detail: result.Detail)
        };
    }

    private MobileSessionResponse CreateSessionResponse(
        MobileSessionIdentity identity,
        long nowMs,
        string refreshToken)
    {
        var issued = accessTokens.Issue(
            identity.UserId,
            identity.SessionId,
            identity.DeviceId,
            nowMs,
            options.AccessTokenLifetimeMs);
        return new(
            identity.SessionId,
            identity.DeviceId,
            issued.Token,
            issued.AccessToken.ExpiresAtMs,
            refreshToken,
            identity.RefreshTokenExpiresAtMs);
    }

    private static bool TryNormalize(
        MobilePairingRequest request,
        out MobilePairingRequest normalized,
        out string? detail)
    {
        normalized = request;
        detail = null;
        if (string.IsNullOrWhiteSpace(request.DeviceName) || request.DeviceName.Trim().Length > 200
            || string.IsNullOrWhiteSpace(request.Platform) || request.Platform.Trim().Length > 64)
        {
            detail = "deviceName and platform are required.";
            return false;
        }

        var capabilities = NormalizeCapabilities(request.Capabilities);
        if (capabilities is null)
        {
            detail = "capabilities is invalid.";
            return false;
        }

        normalized = request with
        {
            DeviceName = request.DeviceName.Trim(),
            Platform = request.Platform.Trim(),
            Capabilities = capabilities
        };
        return true;
    }

    private static string[]? NormalizeCapabilities(IReadOnlyList<string>? values)
    {
        values ??= Array.Empty<string>();
        if (values.Count > 50 || values.Any(value => string.IsNullOrWhiteSpace(value) || value.Length > 100))
        {
            return null;
        }

        return values.Select(value => value.Trim()).Distinct(StringComparer.Ordinal).ToArray();
    }

    private static string Hash(string value) => Convert.ToHexString(SHA256.HashData(System.Text.Encoding.UTF8.GetBytes(value)));

    private static string Base64Url(ReadOnlySpan<byte> bytes) =>
        Convert.ToBase64String(bytes).TrimEnd('=').Replace('+', '-').Replace('/', '_');

    private static MobileOperation<T> Invalid<T>(string detail) => new(MobileOperationStatus.Invalid, Detail: detail);

    private static MobileOperation<T> Unauthorized<T>() => new(MobileOperationStatus.Unauthorized, Detail: "The mobile pairing or session is invalid.");
}

public sealed class MobileSessionOptions
{
    public const string SectionName = "MobileSession";

    public long PairingLifetimeMs { get; set; } = 10 * 60_000;

    public long AccessTokenLifetimeMs { get; set; } = 15 * 60_000;

    public long RefreshTokenLifetimeMs { get; set; } = 30L * 24 * 60 * 60_000;

    public int ExchangePermitLimit { get; set; } = 5;

    public int RefreshPermitLimit { get; set; } = 10;
}
