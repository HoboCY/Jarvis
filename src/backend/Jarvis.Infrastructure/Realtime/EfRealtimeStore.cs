using System.Text.Json;
using Jarvis.Application.Realtime;
using Jarvis.Contracts;
using Jarvis.Domain.Conversations;
using Jarvis.Domain.Devices;
using Jarvis.Domain.Idempotency;
using Jarvis.Domain.Outbox;
using Jarvis.Infrastructure.Data;
using Jarvis.Infrastructure.Idempotency;
using Microsoft.EntityFrameworkCore;
using Microsoft.Data.Sqlite;
using Microsoft.Extensions.Options;

namespace Jarvis.Infrastructure.Realtime;

public sealed class EfRealtimeStore(
    JarvisDbContext db,
    TimeProvider timeProvider,
    IOptions<IdempotencyOptions> idempotencyOptions) : IRealtimeStore
{
    private static readonly JsonSerializerOptions JsonOptions = new(JsonSerializerDefaults.Web);

    public async Task<RealtimeBootstrapContext?> GetBootstrapContextAsync(
        Guid userId,
        RealtimeClientSecretRequest request,
        ContextAssembler assembler,
        CancellationToken cancellationToken)
    {
        var ownsConversation = await db.Conversations.AsNoTracking().AnyAsync(
            conversation => conversation.Id == request.ConversationId && conversation.UserId == userId,
            cancellationToken);
        if (!ownsConversation)
        {
            return null;
        }

        var device = await db.Devices.AsNoTracking().SingleOrDefaultAsync(
            candidate => candidate.Id == request.DeviceId
                && candidate.UserId == userId
                && candidate.DeviceType == DeviceType.Desktop
                && candidate.Status != DeviceStatus.Disabled,
            cancellationToken);
        if (device is null)
        {
            return null;
        }

        var user = await db.Users.AsNoTracking().SingleAsync(item => item.Id == userId, cancellationToken);
        var messages = await db.Messages.AsNoTracking()
            .Where(message => message.ConversationId == request.ConversationId && message.Text != null)
            .OrderBy(message => message.Sequence)
            .Select(message => new ContextMessage(message.Role.ToString(), message.Text!))
            .ToListAsync(cancellationToken);
        var messageVersions = await db.Messages
            .Where(message => message.ConversationId == request.ConversationId)
            .Select(message => new { message.Sequence, message.Version })
            .ToListAsync(cancellationToken);
        var contextVersion = messageVersions.Count == 0
            ? 0L
            : checked(messageVersions.Max(message => message.Sequence) + messageVersions.Sum(message => message.Version));
        var context = assembler.Assemble(new ContextAssemblyInput(
            contextVersion,
            ContextAssembler.FixedInstructions,
            $"locale={user.Locale}; timezone={user.TimeZone}",
            string.Empty,
            messages,
            string.Empty,
            string.Empty));
        return new(userId, request.ConversationId, request.DeviceId, context, request.PreferredVoice);
    }

    public async Task<StoredClientSecretRequest?> FindClientSecretRequestAsync(
        Guid userId,
        string idempotencyKey,
        CancellationToken cancellationToken)
    {
        var record = await FindIdempotencyRecordAsync(
            userId,
            "realtime:client-secrets",
            idempotencyKey,
            cancellationToken);
        if (record is null)
        {
            return null;
        }

        return Deserialize<StoredClientSecretRequest>(record.ResponseJson);
    }

    public async Task<RealtimeSessionStoreResult> CreateSessionAsync(
        Guid userId,
        string idempotencyKey,
        string requestHash,
        RealtimeBootstrapContext bootstrap,
        string model,
        string voice,
        long expiresAtMs,
        Guid sessionId,
        long sessionRotationAtMs,
        CancellationToken cancellationToken)
    {
        const string scope = "realtime:client-secrets";
        await using var transaction = await db.Database.BeginTransactionAsync(cancellationToken);
        var nowMs = timeProvider.GetUtcNow().ToUnixTimeMilliseconds();
        await DeleteExpiredIdempotencyRecordAsync(
            userId,
            scope,
            idempotencyKey,
            nowMs,
            cancellationToken);
        var existing = await FindIdempotencyRecordAsync(userId, scope, idempotencyKey, cancellationToken);
        if (existing is not null)
        {
            if (!string.Equals(existing.RequestHash, requestHash, StringComparison.Ordinal))
            {
                return Conflict("The Idempotency-Key was already used with a different payload.");
            }

            var stored = Deserialize<StoredClientSecretRequest>(existing.ResponseJson);
            if (stored is null)
            {
                return Conflict("The stored realtime request could not be read.");
            }

            var session = await db.RealtimeSessions.SingleOrDefaultAsync(
                item => item.Id == stored.SessionId && item.ConversationId == bootstrap.ConversationId,
                cancellationToken);
            return session is null
                ? NotFound()
                : new(ToResponse(session));
        }

        var ownsConversation = await db.Conversations.AnyAsync(
            conversation => conversation.Id == bootstrap.ConversationId && conversation.UserId == userId,
            cancellationToken);
        var ownsDevice = await db.Devices.AnyAsync(
            device => device.Id == bootstrap.DeviceId
                && device.UserId == userId
                && device.DeviceType == DeviceType.Desktop
                && device.Status != DeviceStatus.Disabled,
            cancellationToken);
        if (!ownsConversation || !ownsDevice)
        {
            return NotFound();
        }

        var sessionEntity = RealtimeSession.Create(
            sessionId,
            bootstrap.ConversationId,
            bootstrap.DeviceId,
            model,
            voice,
            bootstrap.Context.ContextVersion,
            nowMs);
        db.RealtimeSessions.Add(sessionEntity);
        var storedRequest = new StoredClientSecretRequest(
            requestHash,
            sessionId,
            bootstrap.ConversationId,
            bootstrap.DeviceId,
            model,
            voice,
            bootstrap.Context.ContextVersion,
            sessionRotationAtMs);
        db.IdempotencyRecords.Add(CreateIdempotencyRecord(
            userId,
            scope,
            idempotencyKey,
            requestHash,
            JsonSerializer.Serialize(storedRequest, JsonOptions),
            nowMs));
        var eventId = Guid.CreateVersion7();
        db.OutboxMessages.Add(OutboxMessage.Create(
            eventId,
            "realtime.session.created",
            JsonSerializer.Serialize(new
            {
                eventId,
                occurredAt = nowMs,
                type = "realtime.session.created",
                payload = new { userId, sessionId }
            },
            JsonOptions),
            nowMs));
        try
        {
            await db.SaveChangesAsync(cancellationToken);
            await transaction.CommitAsync(cancellationToken);
            return new(ToResponse(sessionEntity));
        }
        catch (DbUpdateException)
        {
            await transaction.RollbackAsync(cancellationToken);
            db.ChangeTracker.Clear();
            var winner = await FindIdempotencyRecordAsync(userId, scope, idempotencyKey, cancellationToken);
            if (winner is null || !string.Equals(winner.RequestHash, requestHash, StringComparison.Ordinal))
            {
                throw;
            }

            var winnerRequest = Deserialize<StoredClientSecretRequest>(winner.ResponseJson);
            var winnerSession = winnerRequest is null
                ? null
                : await db.RealtimeSessions.SingleOrDefaultAsync(
                    item => item.Id == winnerRequest.SessionId && item.ConversationId == bootstrap.ConversationId,
                    cancellationToken);
            return winnerSession is null ? NotFound() : new(ToResponse(winnerSession));
        }
    }

    public async Task<RealtimeSessionStoreResult> GetSessionAsync(
        Guid userId,
        Guid sessionId,
        CancellationToken cancellationToken)
    {
        var session = await FindOwnedSessionAsync(userId, sessionId, cancellationToken);
        return session is null ? NotFound() : new(ToResponse(session));
    }

    public async Task<RealtimeSessionStoreResult> MarkConnectedAsync(
        Guid userId,
        Guid sessionId,
        string idempotencyKey,
        string requestHash,
        RealtimeSessionConnectedRequest request,
        CancellationToken cancellationToken)
    {
        return await UpdateLifecycleAsync(
            userId,
            sessionId,
            idempotencyKey,
            requestHash,
            request,
            session => session.MarkConnected(request.ExternalSessionId, timeProvider.GetUtcNow().ToUnixTimeMilliseconds()),
            cancellationToken);
    }

    public async Task<RealtimeSessionStoreResult> MarkEndedAsync(
        Guid userId,
        Guid sessionId,
        string idempotencyKey,
        string requestHash,
        RealtimeSessionEndedRequest request,
        CancellationToken cancellationToken)
    {
        return await UpdateLifecycleAsync(
            userId,
            sessionId,
            idempotencyKey,
            requestHash,
            request,
            session =>
            {
                var nowMs = timeProvider.GetUtcNow().ToUnixTimeMilliseconds();
                switch (request.Status)
                {
                    case RealtimeSessionStatusValue.Rotated:
                        session.MarkRotated(request.Reason, nowMs);
                        break;
                    case RealtimeSessionStatusValue.Failed:
                        session.MarkFailed(request.Reason, nowMs);
                        break;
                    default:
                        session.MarkDisconnected(request.Reason, nowMs);
                        break;
                }
            },
            cancellationToken);
    }

    public async Task<RealtimeEventStoreResult> IngestEventsAsync(
        Guid userId,
        Guid conversationId,
        string idempotencyKey,
        string requestHash,
        RealtimeEventsIngestRequest request,
        CancellationToken cancellationToken)
    {
        const int maxAttempts = 5;
        for (var attempt = 1; attempt <= maxAttempts; attempt++)
        {
            try
            {
                return await IngestEventsAttemptAsync(
                    userId,
                    conversationId,
                    idempotencyKey,
                    requestHash,
                    request,
                    cancellationToken);
            }
            catch (Exception exception) when (IsConcurrentPersistenceFailure(exception))
            {
                db.ChangeTracker.Clear();
                if (attempt == maxAttempts)
                {
                    // A competing transaction may have won the unique key race.
                    // The caller can retry with the same idempotency key; do not
                    // surface a storage race as an unexplained HTTP 500.
                    return ConflictEvents("Realtime event persistence conflicted with a concurrent write; retry the same request.");
                }

                await Task.Delay(TimeSpan.FromMilliseconds(5L << (attempt - 1)), cancellationToken);
            }
        }

        throw new InvalidOperationException("Realtime event ingestion retry loop did not complete.");
    }

    private async Task<RealtimeEventStoreResult> IngestEventsAttemptAsync(
        Guid userId,
        Guid conversationId,
        string idempotencyKey,
        string requestHash,
        RealtimeEventsIngestRequest request,
        CancellationToken cancellationToken)
    {
        const string scopeSuffix = ":realtime-events";
        var scope = $"conversations:{conversationId}{scopeSuffix}";
        await using var transaction = await db.Database.BeginTransactionAsync(cancellationToken);
        var committed = false;
        try
        {
            var operationNowMs = timeProvider.GetUtcNow().ToUnixTimeMilliseconds();
            var conversation = await db.Conversations.SingleOrDefaultAsync(
                item => item.Id == conversationId && item.UserId == userId,
                cancellationToken);
            if (conversation is null)
            {
                return NotFoundEvents();
            }

            await DeleteExpiredIdempotencyRecordAsync(
                userId,
                scope,
                idempotencyKey,
                operationNowMs,
                cancellationToken);
            var existingBatch = await FindIdempotencyRecordAsync(userId, scope, idempotencyKey, cancellationToken);
            if (existingBatch is not null)
            {
                if (!string.Equals(existingBatch.RequestHash, requestHash, StringComparison.Ordinal))
                {
                    return ConflictEvents("The Idempotency-Key was already used with a different payload.");
                }

                var replay = Deserialize<RealtimeEventsIngestResponse>(existingBatch.ResponseJson);
                return replay is null ? ConflictEvents("The stored realtime event response could not be read.") : new(replay);
            }

            var sessionIds = request.Events.Select(item => item.RealtimeSessionId).Distinct().ToArray();
            var ownedSessions = await db.RealtimeSessions
                .Where(session => session.ConversationId == conversationId && sessionIds.Contains(session.Id))
                .ToDictionaryAsync(session => session.Id, cancellationToken);
            if (ownedSessions.Count != sessionIds.Length)
            {
                var belongsElsewhere = await db.RealtimeSessions.AnyAsync(
                    session => sessionIds.Contains(session.Id) && session.ConversationId != conversationId,
                    cancellationToken);
                return ConflictEvents(belongsElsewhere
                    ? "A realtime session cannot write to another conversation."
                    : "The realtime session does not belong to this conversation.");
            }

            var messageIds = new List<Guid>();
            var accepted = 0;
            var deduplicated = 0;
            var nextSequence = (await db.Messages
                .Where(message => message.ConversationId == conversationId)
                .Select(message => (long?)message.Sequence)
                .MaxAsync(cancellationToken) ?? 0L) + 1L;
            var pendingEvents = new Dictionary<string, string>(StringComparer.Ordinal);
            var pendingMessages = new Dictionary<string, Message>(StringComparer.Ordinal);
            foreach (var item in request.Events)
            {
                var eventId = item.EventId.Trim();
                var externalItemId = item.ExternalItemId?.Trim();
                // Keep the bounded scope independent of the caller-controlled event id.
                // The id remains the idempotency key and is validated separately by the
                // application boundary (max 200 characters).
                var eventScope = $"{scope}:event";
                var eventHash = RequestHash.Create(item);
                if (pendingEvents.TryGetValue(eventId, out var pendingEventHash))
                {
                    if (!string.Equals(pendingEventHash, eventHash, StringComparison.Ordinal))
                    {
                        return ConflictEvents("A realtime event id was already used with a different payload.");
                    }

                    deduplicated++;
                    continue;
                }

                var existingEvent = await FindIdempotencyRecordAsync(userId, eventScope, eventId, cancellationToken);
                if (existingEvent is not null)
                {
                    if (!string.Equals(existingEvent.RequestHash, eventHash, StringComparison.Ordinal))
                    {
                        return ConflictEvents("A realtime event id was already used with a different payload.");
                    }

                    deduplicated++;
                    continue;
                }

                var existingMessage = externalItemId is not null
                    && pendingMessages.TryGetValue(externalItemId, out var pending)
                    ? pending
                    : externalItemId is null
                        ? null
                        : await db.Messages.SingleOrDefaultAsync(
                            message => message.ConversationId == conversationId
                                && message.ExternalItemId == externalItemId,
                            cancellationToken);
                if (existingMessage is null && externalItemId is not null)
                {
                    var belongsElsewhere = await db.Messages.AnyAsync(
                        message => message.ConversationId != conversationId
                            && message.ExternalItemId == externalItemId,
                        cancellationToken);
                    if (belongsElsewhere)
                    {
                        return ConflictEvents("An external realtime item cannot be moved between conversations.");
                    }
                }

                if (existingMessage is not null && existingMessage.RealtimeSessionId != item.RealtimeSessionId)
                {
                    return ConflictEvents("A realtime item cannot be moved between sessions.");
                }

                var status = ToMessageStatus(item.Status);
                var (inputModality, outputModality) = ToModalities(item.Role, item.Modality);
                var nowMs = item.OccurredAtMs ?? timeProvider.GetUtcNow().ToUnixTimeMilliseconds();
                if (existingMessage is null)
                {
                    existingMessage = Message.CreateRealtimeMessage(
                        Guid.CreateVersion7(),
                        conversationId,
                        item.RealtimeSessionId,
                        ToDomainRole(item.Role),
                        inputModality,
                        outputModality,
                        status,
                        item.Text,
                        externalItemId ?? eventId,
                        nextSequence++,
                        nowMs);
                    db.Messages.Add(existingMessage);
                    if (externalItemId is not null)
                    {
                        pendingMessages[externalItemId] = existingMessage;
                    }
                }
                else
                {
                    try
                    {
                        existingMessage.ApplyRealtimeUpdate(status, item.Text, inputModality, outputModality, nowMs);
                    }
                    catch (InvalidOperationException exception)
                    {
                        return ConflictEvents(exception.Message);
                    }
                }

                db.IdempotencyRecords.Add(CreateIdempotencyRecord(
                    userId,
                    eventScope,
                    eventId,
                    eventHash,
                    "{\"accepted\":true}",
                    nowMs));
                pendingEvents[eventId] = eventHash;
                messageIds.Add(existingMessage.Id);
                accepted++;
                conversation.RecordActivity(nowMs);
            }

            var response = new RealtimeEventsIngestResponse(request.Version, accepted, deduplicated, messageIds);
            db.IdempotencyRecords.Add(CreateIdempotencyRecord(
                userId,
                scope,
                idempotencyKey,
                requestHash,
                JsonSerializer.Serialize(response, JsonOptions),
                timeProvider.GetUtcNow().ToUnixTimeMilliseconds()));
            var outboxEventId = Guid.CreateVersion7();
            db.OutboxMessages.Add(OutboxMessage.Create(
                outboxEventId,
                "realtime.events.ingested",
                JsonSerializer.Serialize(new
                {
                    eventId = outboxEventId,
                    occurredAt = timeProvider.GetUtcNow().ToUnixTimeMilliseconds(),
                    type = "realtime.events.ingested",
                    payload = new { userId, conversationId, messageIds = messageIds.ToArray() }
                },
                JsonOptions),
                timeProvider.GetUtcNow().ToUnixTimeMilliseconds()));
            await db.SaveChangesAsync(cancellationToken);
            await transaction.CommitAsync(cancellationToken);
            committed = true;
            return new(response);
        }
        finally
        {
            if (!committed)
            {
                try
                {
                    await transaction.RollbackAsync(CancellationToken.None);
                }
                catch (InvalidOperationException)
                {
                    // The provider may have already rolled back a failed command.
                }
            }
        }
    }

    private static bool IsConcurrentPersistenceFailure(Exception exception)
    {
        SqliteException? sqlite = null;
        for (var current = exception; current is not null; current = current.InnerException)
        {
            if (current is SqliteException candidate)
            {
                sqlite = candidate;
                break;
            }
        }

        if (sqlite is null)
        {
            return false;
        }

        return sqlite.SqliteErrorCode is 5 or 6
            || sqlite.SqliteExtendedErrorCode is 1555 or 2067
            || sqlite.Message.Contains("UNIQUE constraint failed", StringComparison.OrdinalIgnoreCase)
            || sqlite.Message.Contains("PRIMARY KEY constraint failed", StringComparison.OrdinalIgnoreCase);
    }

    public async Task<DesktopDeviceBootstrapResponse?> GetOrCreateDesktopDeviceAsync(
        Guid userId,
        CancellationToken cancellationToken)
    {
        var device = await db.Devices.SingleOrDefaultAsync(
            candidate => candidate.UserId == userId && candidate.DeviceType == DeviceType.Desktop,
            cancellationToken);
        if (device is null)
        {
            device = Device.Create(
                Guid.CreateVersion7(),
                userId,
                "Local Desktop",
                DeviceType.Desktop,
                CurrentPlatform(),
                "{\"realtime\":true,\"microphone\":true,\"audioOutput\":true}",
                timeProvider.GetUtcNow().ToUnixTimeMilliseconds());
            db.Devices.Add(device);
            await db.SaveChangesAsync(cancellationToken);
        }

        return new(
            device.Id,
            device.Name,
            DeviceTypeValue.Desktop,
            device.Platform,
            device.Status switch
            {
                DeviceStatus.Online => DeviceStatusValue.Online,
                DeviceStatus.Disabled => DeviceStatusValue.Disabled,
                _ => DeviceStatusValue.Offline
            });
    }

    private async Task<RealtimeSessionStoreResult> UpdateLifecycleAsync<TRequest>(
        Guid userId,
        Guid sessionId,
        string idempotencyKey,
        string requestHash,
        TRequest request,
        Action<RealtimeSession> update,
        CancellationToken cancellationToken)
    {
        var scope = $"realtime:sessions:{sessionId}:{typeof(TRequest).Name}";
        await using var transaction = await db.Database.BeginTransactionAsync(cancellationToken);
        var nowMs = timeProvider.GetUtcNow().ToUnixTimeMilliseconds();
        await DeleteExpiredIdempotencyRecordAsync(
            userId,
            scope,
            idempotencyKey,
            nowMs,
            cancellationToken);
        var existing = await FindIdempotencyRecordAsync(userId, scope, idempotencyKey, cancellationToken);
        if (existing is not null)
        {
            if (!string.Equals(existing.RequestHash, requestHash, StringComparison.Ordinal))
            {
                return Conflict("The Idempotency-Key was already used with a different payload.");
            }

            var replay = Deserialize<RealtimeSessionResponse>(existing.ResponseJson);
            return replay is null ? Conflict("The stored realtime lifecycle response could not be read.") : new(replay);
        }

        var session = await FindOwnedSessionAsync(userId, sessionId, cancellationToken);
        if (session is null)
        {
            return NotFound();
        }

        if (request is RealtimeSessionConnectedRequest connectedRequest
            && await db.RealtimeSessions.AnyAsync(
                candidate => candidate.Id != sessionId
                    && candidate.ExternalSessionId == connectedRequest.ExternalSessionId,
                cancellationToken))
        {
            return Conflict("The external realtime session identity is already attached to another session.");
        }

        try
        {
            update(session);
        }
        catch (InvalidOperationException exception)
        {
            return Conflict(exception.Message);
        }

        var response = ToResponse(session);
        db.IdempotencyRecords.Add(CreateIdempotencyRecord(
            userId,
            scope,
            idempotencyKey,
            requestHash,
            JsonSerializer.Serialize(response, JsonOptions),
            nowMs));
        var eventType = typeof(TRequest) == typeof(RealtimeSessionConnectedRequest)
            ? "realtime.session.connected"
            : "realtime.session.ended";
        var eventId = Guid.CreateVersion7();
        var occurredAtMs = nowMs;
        db.OutboxMessages.Add(OutboxMessage.Create(
            eventId,
            eventType,
            JsonSerializer.Serialize(new
            {
                eventId,
                occurredAt = occurredAtMs,
                type = eventType,
                payload = new { userId, sessionId }
            },
            JsonOptions),
            occurredAtMs));
        await db.SaveChangesAsync(cancellationToken);
        await transaction.CommitAsync(cancellationToken);
        _ = request;
        return new(response);
    }

    private Task<RealtimeSession?> FindOwnedSessionAsync(Guid userId, Guid sessionId, CancellationToken cancellationToken)
    {
        return db.RealtimeSessions
            .SingleOrDefaultAsync(
                session => session.Id == sessionId
                    && db.Conversations.Any(conversation => conversation.Id == session.ConversationId && conversation.UserId == userId),
                cancellationToken);
    }

    private Task<IdempotencyRecord?> FindIdempotencyRecordAsync(
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

    private Task<int> DeleteExpiredIdempotencyRecordAsync(
        Guid userId,
        string scope,
        string idempotencyKey,
        long nowMs,
        CancellationToken cancellationToken)
    {
        return db.IdempotencyRecords
            .Where(record => record.UserId == userId
                && record.Scope == scope
                && record.IdempotencyKey == idempotencyKey
                && record.ExpiresAtMs <= nowMs)
            .ExecuteDeleteAsync(cancellationToken);
    }

    private IdempotencyRecord CreateIdempotencyRecord(
        Guid userId,
        string scope,
        string key,
        string requestHash,
        string responseJson,
        long nowMs)
    {
        return IdempotencyRecord.Create(
            userId,
            scope,
            key,
            requestHash,
            200,
            responseJson,
            nowMs,
            checked(nowMs + idempotencyOptions.Value.RetentionMs));
    }

    private static T? Deserialize<T>(string json)
    {
        try
        {
            return JsonSerializer.Deserialize<T>(json, JsonOptions);
        }
        catch (JsonException)
        {
            return default;
        }
    }

    private static RealtimeSessionResponse ToResponse(RealtimeSession session)
    {
        return new(
            session.Id,
            session.ConversationId,
            session.DeviceId,
            session.ExternalSessionId,
            session.Model,
            session.Voice,
            session.ContextVersion,
            session.Status switch
            {
                RealtimeSessionStatus.Created => RealtimeSessionStatusValue.Created,
                RealtimeSessionStatus.Connected => RealtimeSessionStatusValue.Connected,
                RealtimeSessionStatus.Rotated => RealtimeSessionStatusValue.Rotated,
                RealtimeSessionStatus.Failed => RealtimeSessionStatusValue.Failed,
                _ => RealtimeSessionStatusValue.Disconnected
            },
            session.StartedAtMs,
            session.EndedAtMs,
            session.EndReason);
    }

    private static MessageStatus ToMessageStatus(RealtimeEventStatusValue status) => status switch
    {
        RealtimeEventStatusValue.Partial or RealtimeEventStatusValue.Streaming => MessageStatus.Streaming,
        RealtimeEventStatusValue.Completed => MessageStatus.Completed,
        RealtimeEventStatusValue.Interrupted => MessageStatus.Interrupted,
        RealtimeEventStatusValue.Failed => MessageStatus.Failed,
        _ => throw new ArgumentOutOfRangeException(nameof(status), status, null)
    };

    private static (MessageInputModality?, MessageOutputModality?) ToModalities(MessageRoleValue role, string modality)
    {
        if (role == MessageRoleValue.User)
        {
            return (string.Equals(modality, "typedText", StringComparison.OrdinalIgnoreCase)
                ? MessageInputModality.TypedText
                : MessageInputModality.Voice, null);
        }

        return (null, string.Equals(modality, "audio", StringComparison.OrdinalIgnoreCase)
            || string.Equals(modality, "audioWithTranscript", StringComparison.OrdinalIgnoreCase)
            ? MessageOutputModality.AudioWithTranscript
            : MessageOutputModality.Text);
    }

    private static MessageRole ToDomainRole(MessageRoleValue role) => role switch
    {
        MessageRoleValue.User => MessageRole.User,
        MessageRoleValue.Assistant => MessageRole.Assistant,
        _ => throw new ArgumentOutOfRangeException(nameof(role), role, "Only user and assistant realtime messages are accepted.")
    };

    private static RealtimeSessionStoreResult NotFound() => new(null, NotFound: true);

    private static RealtimeSessionStoreResult Conflict(string detail) => new(null, Conflict: true, Detail: detail);

    private static RealtimeEventStoreResult NotFoundEvents() => new(null, NotFound: true);

    private static RealtimeEventStoreResult ConflictEvents(string detail) => new(null, Conflict: true, Detail: detail);

    private static class RequestHash
    {
        public static string Create<T>(T value)
        {
            var json = JsonSerializer.Serialize(value, JsonOptions);
            return Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(System.Text.Encoding.UTF8.GetBytes(json)));
        }
    }

    private static string CurrentPlatform()
    {
        return OperatingSystem.IsMacOS()
            ? "macos"
            : OperatingSystem.IsWindows()
                ? "windows"
                : OperatingSystem.IsLinux()
                    ? "linux"
                    : "unknown";
    }
}
