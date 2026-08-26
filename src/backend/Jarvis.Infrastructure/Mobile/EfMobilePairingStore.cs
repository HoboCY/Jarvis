using System.Data.Common;
using System.Data;
using System.Text.Json;
using Jarvis.Application.Mobile;
using Jarvis.Contracts;
using Jarvis.Domain.Devices;
using Jarvis.Domain.Idempotency;
using Jarvis.Domain.Mobile;
using Jarvis.Infrastructure.Data;
using Jarvis.Infrastructure.Idempotency;
using Microsoft.EntityFrameworkCore;
using Microsoft.Data.Sqlite;
using Microsoft.Extensions.Options;

namespace Jarvis.Infrastructure.Mobile;

public sealed class EfMobilePairingStore(
    JarvisDbContext db,
    IOptions<IdempotencyOptions> idempotencyOptions) : IMobilePairingStore
{
    private const int MaxRevokeConcurrencyRetries = 3;
    private const int PersistenceCommandTimeoutSeconds = 1;
    private static readonly JsonSerializerOptions JsonOptions = new(JsonSerializerDefaults.Web);

    public async Task<MobilePairingStoreResult> CreatePairingAsync(
        Guid userId,
        MobilePairingRequest request,
        string idempotencyKey,
        string codeHash,
        long createdAtMs,
        long expiresAtMs,
        CancellationToken cancellationToken)
    {
        const string scope = "mobile-pairings:create";
        var requestHash = Hash(request);
        var existing = await db.IdempotencyRecords.AsNoTracking().SingleOrDefaultAsync(
            record => record.UserId == userId
                && record.Scope == scope
                && record.IdempotencyKey == idempotencyKey
                && record.ExpiresAtMs > createdAtMs,
            cancellationToken);
        if (existing is not null)
        {
            return new(Guid.Empty, 0, Conflict: true, Detail: string.Equals(existing.RequestHash, requestHash, StringComparison.Ordinal)
                ? "The one-time pairing code was already issued."
                : "The Idempotency-Key was already used with a different payload.");
        }

        await using var transaction = await db.Database.BeginTransactionAsync(IsolationLevel.Serializable, cancellationToken);
        var pairing = MobilePairing.Create(
            Guid.CreateVersion7(),
            userId,
            codeHash,
            request.DeviceName,
            request.Platform,
            JsonSerializer.Serialize(request.Capabilities ?? Array.Empty<string>(), JsonOptions),
            createdAtMs,
            expiresAtMs);
        db.MobilePairings.Add(pairing);
        db.IdempotencyRecords.Add(IdempotencyRecord.Create(
            userId,
            scope,
            idempotencyKey,
            requestHash,
            201,
            JsonSerializer.Serialize(new { pairingId = pairing.Id, expiresAtMs }, JsonOptions),
            createdAtMs,
            checked(createdAtMs + idempotencyOptions.Value.RetentionMs)));
        await db.SaveChangesAsync(cancellationToken);
        await transaction.CommitAsync(cancellationToken);
        return new(pairing.Id, pairing.ExpiresAtMs);
    }

    public async Task<MobileSessionStoreResult> ExchangeAsync(
        MobilePairingExchangeRequest request,
        string codeHash,
        string deviceName,
        string platform,
        IReadOnlyList<string> capabilities,
        string refreshTokenHash,
        long nowMs,
        long refreshTokenExpiresAtMs,
        CancellationToken cancellationToken)
    {
        ConfigurePersistenceTimeout();
        try
        {
            await using var transaction = await db.Database.BeginTransactionAsync(IsolationLevel.Serializable, cancellationToken);
            var pairing = await db.MobilePairings.SingleOrDefaultAsync(
                item => item.CodeHash == codeHash,
                cancellationToken);
            if (pairing is null || !pairing.TryConsume(nowMs))
            {
                return new(Unauthorized: true);
            }

            var effectiveName = string.IsNullOrWhiteSpace(request.DeviceName) ? pairing.DeviceName : deviceName;
            var effectivePlatform = string.IsNullOrWhiteSpace(request.Platform) ? pairing.Platform : platform;
            var effectiveCapabilities = capabilities.Count == 0
                ? DeserializeCapabilities(pairing.CapabilitiesJson)
                : capabilities.ToArray();
            var device = Device.Create(
                Guid.CreateVersion7(),
                pairing.UserId,
                effectiveName,
                DeviceType.Mobile,
                effectivePlatform,
                JsonSerializer.Serialize(effectiveCapabilities, JsonOptions),
                nowMs);
            var session = MobileSession.Create(
                Guid.CreateVersion7(),
                pairing.UserId,
                device.Id,
                refreshTokenHash,
                nowMs,
                refreshTokenExpiresAtMs);
            db.Devices.Add(device);
            db.MobileSessions.Add(session);
            await db.SaveChangesAsync(cancellationToken);
            await transaction.CommitAsync(cancellationToken);
            return new(new(session.Id, session.UserId, session.DeviceId, session.RefreshTokenExpiresAtMs));
        }
        catch (Exception exception) when (IsConcurrentPersistenceFailure(exception))
        {
            db.ChangeTracker.Clear();
            // Pairing exchange is anonymous: a lock/concurrency loser must not
            // disclose whether another request consumed this code.
            return new(Unauthorized: true);
        }
    }

    public async Task<MobileSessionStoreResult> RotateRefreshTokenAsync(
        Guid sessionId,
        string refreshTokenHash,
        string replacementRefreshTokenHash,
        long nowMs,
        long refreshTokenExpiresAtMs,
        CancellationToken cancellationToken)
    {
        ConfigurePersistenceTimeout();
        try
        {
            await using var transaction = await db.Database.BeginTransactionAsync(IsolationLevel.Serializable, cancellationToken);
            var session = await db.MobileSessions.SingleOrDefaultAsync(item => item.Id == sessionId, cancellationToken);
            if (session is null || !session.CanRefresh(nowMs, Convert.FromHexString(refreshTokenHash)))
            {
                return new(Unauthorized: true);
            }

            if (!session.RotateRefreshToken(replacementRefreshTokenHash, nowMs, refreshTokenExpiresAtMs))
            {
                return new(Unauthorized: true);
            }

            await db.SaveChangesAsync(cancellationToken);
            await transaction.CommitAsync(cancellationToken);
            return new(new(session.Id, session.UserId, session.DeviceId, session.RefreshTokenExpiresAtMs));
        }
        catch (Exception exception) when (IsConcurrentPersistenceFailure(exception))
        {
            db.ChangeTracker.Clear();
            // The old refresh token is single-use. A concurrency loser must
            // look exactly like an invalid token to an anonymous caller.
            return new(Unauthorized: true);
        }
    }

    public async Task<MobileOperation<MobileSessionRevokeResponse>> RevokeAsync(
        Guid userId,
        Guid sessionId,
        long nowMs,
        CancellationToken cancellationToken)
    {
        ConfigurePersistenceTimeout();
        for (var attempt = 0; attempt < MaxRevokeConcurrencyRetries; attempt++)
        {
            try
            {
                await using var transaction = await db.Database.BeginTransactionAsync(IsolationLevel.Serializable, cancellationToken);
                var session = await db.MobileSessions.SingleOrDefaultAsync(
                    item => item.Id == sessionId && item.UserId == userId,
                    cancellationToken);
                if (session is null)
                {
                    return new(MobileOperationStatus.NotFound);
                }

                session.Revoke(nowMs);
                await db.SaveChangesAsync(cancellationToken);
                await transaction.CommitAsync(cancellationToken);
                return new(MobileOperationStatus.Succeeded, new MobileSessionRevokeResponse(sessionId, true));
            }
            catch (Exception exception) when (IsConcurrentPersistenceFailure(exception))
            {
                db.ChangeTracker.Clear();
                if (attempt + 1 >= MaxRevokeConcurrencyRetries)
                {
                    return new(MobileOperationStatus.Unavailable, Detail: "The mobile session could not be revoked while the database was busy.");
                }

                // A refresh may have won the SQLite write race. Re-read after a
                // bounded backoff so revoke still becomes authoritative instead
                // of leaving the newly rotated token usable.
                await Task.Delay(TimeSpan.FromMilliseconds(5 * (attempt + 1)), cancellationToken);
            }
        }

        return new(MobileOperationStatus.Unavailable, Detail: "The mobile session could not be revoked while the database was busy.");
    }

    private void ConfigurePersistenceTimeout()
    {
        db.Database.SetCommandTimeout(PersistenceCommandTimeoutSeconds);
        if (db.Database.GetDbConnection() is SqliteConnection sqlite)
        {
            // SQLite also uses the connection default for internal BEGIN
            // commands, so bound lock waits before the first transaction is
            // opened as well as EF-generated SQL commands.
            sqlite.DefaultTimeout = PersistenceCommandTimeoutSeconds;
        }
    }

    private static string Hash<T>(T value) => Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(
        System.Text.Encoding.UTF8.GetBytes(JsonSerializer.Serialize(value, JsonOptions))));

    private static string[] DeserializeCapabilities(string json)
    {
        try
        {
            return JsonSerializer.Deserialize<string[]>(json, JsonOptions) ?? Array.Empty<string>();
        }
        catch (JsonException)
        {
            return Array.Empty<string>();
        }
    }

    private static bool IsConcurrentPersistenceFailure(Exception exception)
    {
        for (var current = exception; current is not null; current = current.InnerException)
        {
            if (current is DbUpdateConcurrencyException)
            {
                return true;
            }

            if (current is SqliteException sqlite && sqlite.SqliteErrorCode is 5 or 6)
            {
                return true;
            }

            if (current is DbException databaseException
                && (databaseException.Message.Contains("BUSY", StringComparison.OrdinalIgnoreCase)
                    || databaseException.Message.Contains("LOCKED", StringComparison.OrdinalIgnoreCase)))
            {
                return true;
            }
        }

        return false;
    }
}
