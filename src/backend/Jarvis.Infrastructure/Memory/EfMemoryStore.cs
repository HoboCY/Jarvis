using System.Data.Common;
using System.Text.Json;
using System.Text.RegularExpressions;
using Jarvis.Application.Memory;
using Jarvis.Contracts;
using Jarvis.Domain.Conversations;
using Jarvis.Domain.Idempotency;
using Jarvis.Domain.Memory;
using Jarvis.Domain.Outbox;
using Jarvis.Infrastructure.Data;
using Jarvis.Infrastructure.Idempotency;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Options;

namespace Jarvis.Infrastructure.Memory;

public sealed class EfMemoryStore(
    JarvisDbContext db,
    TimeProvider timeProvider,
    IOptions<IdempotencyOptions> idempotencyOptions) : IMemoryStore
{
    private static readonly JsonSerializerOptions JsonOptions = new(JsonSerializerDefaults.Web);
    private static readonly Regex RememberIntent = new("\\bremember\\b", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant | RegexOptions.Compiled);
    private const int MaxWriteAttempts = 5;

    public async Task<MemoryOperation<MemoryFactSaveResponse>> SaveAsync(
        Guid userId,
        string idempotencyKey,
        string requestHash,
        CreateMemoryFactRequest request,
        bool allowSensitive,
        CancellationToken cancellationToken)
    {
        const string scope = "memory-facts:create";
        var existing = await FindIdempotencyAsync(userId, scope, idempotencyKey, cancellationToken);
        if (existing is not null)
        {
            return ReplaySave(existing, requestHash);
        }

        for (var attempt = 1; ; attempt++)
        {
            try
            {
                return await SaveOnceAsync(
                    userId,
                    scope,
                    idempotencyKey,
                    requestHash,
                    request,
                    allowSensitive,
                    cancellationToken);
            }
            catch (Exception exception) when (attempt < MaxWriteAttempts && IsWriteRace(exception))
            {
                db.ChangeTracker.Clear();
                existing = await FindIdempotencyAsync(userId, scope, idempotencyKey, cancellationToken);
                if (existing is not null)
                {
                    return ReplaySave(existing, requestHash);
                }

                await Task.Delay(TimeSpan.FromMilliseconds(10L * attempt), cancellationToken);
            }
        }
    }

    private async Task<MemoryOperation<MemoryFactSaveResponse>> SaveOnceAsync(
        Guid userId,
        string scope,
        string idempotencyKey,
        string requestHash,
        CreateMemoryFactRequest request,
        bool allowSensitive,
        CancellationToken cancellationToken)
    {
        await using var transaction = await db.Database.BeginTransactionAsync(cancellationToken);
        var nowMs = timeProvider.GetUtcNow().ToUnixTimeMilliseconds();
        await DeleteExpiredIdempotencyAsync(userId, scope, idempotencyKey, nowMs, cancellationToken);

        var existing = await FindIdempotencyAsync(userId, scope, idempotencyKey, cancellationToken);
        if (existing is not null)
        {
            return ReplaySave(existing, requestHash);
        }

        if (request.Sensitive && !allowSensitive)
        {
            return Invalid<MemoryFactSaveResponse>("Sensitive memory facts are disabled by policy.");
        }

        var source = await (
            from message in db.Messages
            join conversation in db.Conversations on message.ConversationId equals conversation.Id
            where message.Id == request.SourceMessageId
                && conversation.UserId == userId
                && message.Role == MessageRole.User
            select new { message.Text, message.Status }).SingleOrDefaultAsync(cancellationToken);
        if (source is null)
        {
            return Invalid<MemoryFactSaveResponse>("sourceMessageId must be a User message in an owned conversation.");
        }

        if (!HasExplicitRememberIntent(source.Text))
        {
            return Invalid<MemoryFactSaveResponse>("sourceMessageId must contain an explicit remember intent.");
        }

        var previous = await db.MemoryFacts
            .SingleOrDefaultAsync(
                fact => fact.UserId == userId
                    && fact.Key == request.Key
                    && fact.Status == MemoryFactStatus.Active,
                cancellationToken);
        if (previous is not null)
        {
            previous.Retract(nowMs);
        }

        var fact = MemoryFact.CreateDirect(
            Guid.CreateVersion7(),
            userId,
            request.Key,
            JsonSerializer.Serialize(request.Value, JsonOptions),
            request.SourceMessageId,
            request.Sensitive,
            nowMs,
            previous?.Id);
        db.MemoryFacts.Add(fact);

        var response = new MemoryFactSaveResponse(true, fact.Id);
        db.IdempotencyRecords.Add(CreateIdempotencyRecord(
            userId,
            scope,
            idempotencyKey,
            requestHash,
            200,
            JsonSerializer.Serialize(response, JsonOptions),
            nowMs));
        AddOutbox("memory.fact.saved", new
        {
            userId,
            memoryId = fact.Id,
            supersedesMemoryId = previous?.Id,
            key = fact.Key,
            sensitive = fact.Sensitive
        }, nowMs);

        await db.SaveChangesAsync(cancellationToken);
        await transaction.CommitAsync(cancellationToken);
        return new(MemoryOperationStatus.Succeeded, response);
    }

    public async Task<MemoryOperation<MemoryFactRetractResponse>> RetractAsync(
        Guid userId,
        Guid memoryId,
        string idempotencyKey,
        string requestHash,
        CancellationToken cancellationToken)
    {
        var scope = $"memory-facts:{memoryId}:retract";
        var existing = await FindIdempotencyAsync(userId, scope, idempotencyKey, cancellationToken);
        if (existing is not null)
        {
            return ReplayRetract(existing, requestHash);
        }

        await using var transaction = await db.Database.BeginTransactionAsync(cancellationToken);
        var nowMs = timeProvider.GetUtcNow().ToUnixTimeMilliseconds();
        await DeleteExpiredIdempotencyAsync(userId, scope, idempotencyKey, nowMs, cancellationToken);
        existing = await FindIdempotencyAsync(userId, scope, idempotencyKey, cancellationToken);
        if (existing is not null)
        {
            return ReplayRetract(existing, requestHash);
        }

        var fact = await db.MemoryFacts.SingleOrDefaultAsync(
            candidate => candidate.Id == memoryId && candidate.UserId == userId,
            cancellationToken);
        if (fact is null)
        {
            return new(MemoryOperationStatus.NotFound);
        }

        var changed = fact.Retract(nowMs);
        var response = new MemoryFactRetractResponse(
            fact.Id,
            changed,
            MemoryFactStatusValue.Retracted);
        db.IdempotencyRecords.Add(CreateIdempotencyRecord(
            userId,
            scope,
            idempotencyKey,
            requestHash,
            200,
            JsonSerializer.Serialize(response, JsonOptions),
            nowMs));
        if (changed)
        {
            AddOutbox("memory.fact.retracted", new { userId, memoryId = fact.Id }, nowMs);
        }

        await db.SaveChangesAsync(cancellationToken);
        await transaction.CommitAsync(cancellationToken);
        return new(MemoryOperationStatus.Succeeded, response);
    }

    public async Task<IReadOnlyList<MemoryFactContextItem>> GetActiveForContextAsync(
        Guid userId,
        CancellationToken cancellationToken,
        int maxItems = 100)
    {
        maxItems = Math.Clamp(maxItems, 1, 500);
        var facts = await db.MemoryFacts
            .AsNoTracking()
            .Where(fact => fact.UserId == userId
                && fact.Status == MemoryFactStatus.Active
                && !fact.Sensitive)
            .OrderBy(fact => fact.Key)
            .ThenBy(fact => fact.Id)
            .Take(maxItems)
            .ToListAsync(cancellationToken);
        return facts.Select(fact => new MemoryFactContextItem(
            fact.Key,
            DeserializeValue(fact.ValueJson),
            fact.Sensitive,
            fact.Version,
            fact.Id)).ToArray();
    }

    private static string DeserializeValue(string valueJson)
    {
        try
        {
            return JsonSerializer.Deserialize<string>(valueJson, JsonOptions) ?? valueJson;
        }
        catch (JsonException)
        {
            return valueJson;
        }
    }

    private IdempotencyRecord CreateIdempotencyRecord(
        Guid userId,
        string scope,
        string idempotencyKey,
        string requestHash,
        int status,
        string responseJson,
        long nowMs) => IdempotencyRecord.Create(
            userId,
            scope,
            idempotencyKey,
            requestHash,
            status,
            responseJson,
            nowMs,
            checked(nowMs + idempotencyOptions.Value.RetentionMs));

    private void AddOutbox(string eventType, object payload, long nowMs)
    {
        var eventId = Guid.CreateVersion7();
        db.OutboxMessages.Add(OutboxMessage.Create(
            eventId,
            eventType,
            JsonSerializer.Serialize(new { eventId, occurredAt = nowMs, type = eventType, payload }, JsonOptions),
            nowMs));
    }

    private Task<IdempotencyRecord?> FindIdempotencyAsync(
        Guid userId,
        string scope,
        string key,
        CancellationToken cancellationToken)
    {
        var nowMs = timeProvider.GetUtcNow().ToUnixTimeMilliseconds();
        return db.IdempotencyRecords.AsNoTracking().SingleOrDefaultAsync(
            record => record.UserId == userId
                && record.Scope == scope
                && record.IdempotencyKey == key
                && record.ExpiresAtMs > nowMs,
            cancellationToken);
    }

    private Task<int> DeleteExpiredIdempotencyAsync(
        Guid userId,
        string scope,
        string key,
        long nowMs,
        CancellationToken cancellationToken) => db.IdempotencyRecords
        .Where(record => record.UserId == userId
            && record.Scope == scope
            && record.IdempotencyKey == key
            && record.ExpiresAtMs <= nowMs)
        .ExecuteDeleteAsync(cancellationToken);

    private static MemoryOperation<MemoryFactSaveResponse> ReplaySave(IdempotencyRecord record, string requestHash) =>
        Replay<MemoryFactSaveResponse>(record, requestHash, static response => new(MemoryOperationStatus.Replayed, response));

    private static MemoryOperation<MemoryFactRetractResponse> ReplayRetract(IdempotencyRecord record, string requestHash) =>
        Replay<MemoryFactRetractResponse>(record, requestHash, static response => new(MemoryOperationStatus.Replayed, response));

    private static MemoryOperation<T> Replay<T>(
        IdempotencyRecord record,
        string requestHash,
        Func<T, MemoryOperation<T>> create)
    {
        if (!string.Equals(record.RequestHash, requestHash, StringComparison.Ordinal))
        {
            return new(MemoryOperationStatus.Conflict, Detail: "The Idempotency-Key was already used with a different payload.");
        }

        try
        {
            var response = JsonSerializer.Deserialize<T>(record.ResponseJson, JsonOptions);
            return response is null
                ? new(MemoryOperationStatus.Conflict, Detail: "The stored idempotent response could not be read.")
                : create(response);
        }
        catch (JsonException)
        {
            return new(MemoryOperationStatus.Conflict, Detail: "The stored idempotent response could not be read.");
        }
    }

    private static MemoryOperation<T> Invalid<T>(string detail) => new(MemoryOperationStatus.Invalid, Detail: detail);

    private static bool HasExplicitRememberIntent(string? text) =>
        !string.IsNullOrWhiteSpace(text)
        && (text.Contains("记住", StringComparison.Ordinal)
            || RememberIntent.IsMatch(text));

    private static bool IsWriteRace(Exception exception)
    {
        for (var current = exception; current is not null; current = current.InnerException)
        {
            if (current is DbUpdateException or DbException)
            {
                return true;
            }
        }

        return false;
    }
}
