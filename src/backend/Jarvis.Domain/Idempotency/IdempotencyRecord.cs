namespace Jarvis.Domain.Idempotency;

public sealed class IdempotencyRecord
{
    private IdempotencyRecord()
    {
    }

    private IdempotencyRecord(
        Guid userId,
        string scope,
        string idempotencyKey,
        string requestHash,
        int responseStatus,
        string responseJson,
        long createdAtMs,
        long expiresAtMs)
    {
        UserId = userId;
        Scope = scope;
        IdempotencyKey = idempotencyKey;
        RequestHash = requestHash;
        ResponseStatus = responseStatus;
        ResponseJson = responseJson;
        CreatedAtMs = createdAtMs;
        ExpiresAtMs = expiresAtMs;
    }

    public Guid UserId { get; private set; }

    public string Scope { get; private set; } = string.Empty;

    public string IdempotencyKey { get; private set; } = string.Empty;

    public string RequestHash { get; private set; } = string.Empty;

    public int ResponseStatus { get; private set; }

    public string ResponseJson { get; private set; } = string.Empty;

    public long CreatedAtMs { get; private set; }

    public long ExpiresAtMs { get; private set; }

    public long Version { get; private set; }

    public static IdempotencyRecord Create(
        Guid userId,
        string scope,
        string idempotencyKey,
        string requestHash,
        int responseStatus,
        string responseJson,
        long createdAtMs,
        long expiresAtMs)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(scope);
        ArgumentException.ThrowIfNullOrWhiteSpace(idempotencyKey);
        ArgumentException.ThrowIfNullOrWhiteSpace(requestHash);
        ArgumentException.ThrowIfNullOrWhiteSpace(responseJson);

        return new IdempotencyRecord(
            userId,
            scope.Trim(),
            idempotencyKey.Trim(),
            requestHash,
            responseStatus,
            responseJson,
            createdAtMs,
            expiresAtMs);
    }
}
