using System.Globalization;
using System.Data.Common;
using System.Text.Json;
using Jarvis.Application.Conversations;
using Jarvis.Contracts;
using Jarvis.Domain.Conversations;
using Jarvis.Domain.Idempotency;
using Jarvis.Domain.Outbox;
using Jarvis.Infrastructure.Data;
using Jarvis.Infrastructure.Idempotency;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Options;
using DomainConversationStatus = Jarvis.Domain.Conversations.ConversationStatus;
using DomainInputModality = Jarvis.Domain.Conversations.MessageInputModality;
using DomainMessageOutputModality = Jarvis.Domain.Conversations.MessageOutputModality;
using DomainMessageRole = Jarvis.Domain.Conversations.MessageRole;
using DomainMessageStatus = Jarvis.Domain.Conversations.MessageStatus;

namespace Jarvis.Infrastructure.Conversations;

public sealed class EfConversationStore(
    JarvisDbContext db,
    TimeProvider timeProvider,
    IOptions<IdempotencyOptions> idempotencyOptions) : IConversationStore
{
    private static readonly JsonSerializerOptions JsonOptions = new(JsonSerializerDefaults.Web);
    private const int MaxWriteAttempts = 5;

    public async Task<ConversationStoreResult> CreateAsync(
        Guid userId,
        string idempotencyKey,
        string requestHash,
        CreateConversationRequest request,
        CancellationToken cancellationToken)
    {
        const string scope = "conversations:create";
        var existing = await FindIdempotencyRecordAsync(
            userId,
            scope,
            idempotencyKey,
            cancellationToken);
        if (existing is not null)
        {
            return ReplayCreate(existing, requestHash);
        }

        for (var attempt = 1; ; attempt++)
        {
            try
            {
                return await CreateOnceAsync(
                    userId,
                    scope,
                    idempotencyKey,
                    requestHash,
                    request,
                    cancellationToken);
            }
            catch (Exception exception) when (attempt < MaxWriteAttempts && IsWriteRace(exception))
            {
                db.ChangeTracker.Clear();
                existing = await FindIdempotencyRecordAsync(
                    userId,
                    scope,
                    idempotencyKey,
                    cancellationToken);
                if (existing is not null)
                {
                    return ReplayCreate(existing, requestHash);
                }

                await Task.Delay(TimeSpan.FromMilliseconds(10L * attempt), cancellationToken);
            }
        }
    }

    private async Task<ConversationStoreResult> CreateOnceAsync(
        Guid userId,
        string scope,
        string idempotencyKey,
        string requestHash,
        CreateConversationRequest request,
        CancellationToken cancellationToken)
    {
        await using var transaction = await db.Database.BeginTransactionAsync(cancellationToken);
        var nowMs = timeProvider.GetUtcNow().ToUnixTimeMilliseconds();
        await DeleteExpiredIdempotencyRecordAsync(
            userId,
            scope,
            idempotencyKey,
            nowMs,
            cancellationToken);
        var conversation = Conversation.Create(Guid.CreateVersion7(), userId, request.Title ?? string.Empty, nowMs);
        db.Conversations.Add(conversation);

        var response = new ConversationResponse(
            conversation.Id,
            conversation.Title,
            ToContractStatus(conversation.Status),
            conversation.LastActivityAtMs,
            conversation.CreatedAtMs,
            Array.Empty<MessageResponse>(),
            0);

        db.IdempotencyRecords.Add(CreateIdempotencyRecord(
            userId,
            scope,
            idempotencyKey,
            requestHash,
            StatusCodes.Created,
            JsonSerializer.Serialize(response, JsonOptions),
            nowMs));
        AddOutbox("conversation.created", new
        {
            userId,
            conversationId = conversation.Id,
            title = conversation.Title
        },
        nowMs);

        await db.SaveChangesAsync(cancellationToken);
        await transaction.CommitAsync(cancellationToken);
        return new(ConversationStoreResultKind.Created, response);
    }

    public async Task<ConversationResponse?> GetAsync(
        Guid userId,
        Guid conversationId,
        CancellationToken cancellationToken)
    {
        var conversation = await db.Conversations
            .AsNoTracking()
            .SingleOrDefaultAsync(
                item => item.Id == conversationId && item.UserId == userId,
                cancellationToken);
        if (conversation is null)
        {
            return null;
        }

        var messages = await db.Messages
            .AsNoTracking()
            .Where(message => message.ConversationId == conversationId)
            .OrderByDescending(message => message.Sequence)
            .Take(20)
            .ToListAsync(cancellationToken);
        messages.Reverse();
        var messageCount = await db.Messages.CountAsync(
            message => message.ConversationId == conversationId,
            cancellationToken);

        return ToConversationResponse(conversation, messages, messageCount);
    }

    public async Task<MessagePageResponse?> GetMessagesAsync(
        Guid userId,
        Guid conversationId,
        long? cursor,
        int limit,
        CancellationToken cancellationToken)
    {
        var ownsConversation = await db.Conversations.AsNoTracking().AnyAsync(
            conversation => conversation.Id == conversationId && conversation.UserId == userId,
            cancellationToken);
        if (!ownsConversation)
        {
            return null;
        }

        var query = db.Messages
            .AsNoTracking()
            .Where(message => message.ConversationId == conversationId);
        if (cursor is not null)
        {
            query = query.Where(message => message.Sequence < cursor.Value);
        }

        var messages = await query
            .OrderByDescending(message => message.Sequence)
            .Take(limit + 1)
            .ToListAsync(cancellationToken);
        var hasMore = messages.Count > limit;
        if (hasMore)
        {
            messages.RemoveAt(messages.Count - 1);
        }

        var nextCursor = hasMore
            ? messages[^1].Sequence.ToString(CultureInfo.InvariantCulture)
            : null;
        return new(messages.Select(ToMessageResponse).ToArray(), nextCursor);
    }

    public async Task<TypedMessageStoreResult> AddTypedMessageAsync(
        Guid userId,
        Guid conversationId,
        string idempotencyKey,
        string requestHash,
        TypedMessageRequest request,
        CancellationToken cancellationToken)
    {
        var ownsConversation = await db.Conversations.AsNoTracking().AnyAsync(
            item => item.Id == conversationId && item.UserId == userId,
            cancellationToken);
        if (!ownsConversation)
        {
            return new(ConversationStoreResultKind.NotFound);
        }

        var scope = $"conversations:{conversationId}:messages:typed";
        var existing = await FindIdempotencyRecordAsync(
            userId,
            scope,
            idempotencyKey,
            cancellationToken);
        if (existing is not null)
        {
            return ReplayTyped(existing, requestHash);
        }

        for (var attempt = 1; ; attempt++)
        {
            try
            {
                return await AddTypedMessageOnceAsync(
                    userId,
                    conversationId,
                    scope,
                    idempotencyKey,
                    requestHash,
                    request,
                    cancellationToken);
            }
            catch (Exception exception) when (attempt < MaxWriteAttempts && IsWriteRace(exception))
            {
                db.ChangeTracker.Clear();
                existing = await FindIdempotencyRecordAsync(
                    userId,
                    scope,
                    idempotencyKey,
                    cancellationToken);
                if (existing is not null)
                {
                    return ReplayTyped(existing, requestHash);
                }

                await Task.Delay(TimeSpan.FromMilliseconds(10L * attempt), cancellationToken);
            }
        }
    }

    private async Task<TypedMessageStoreResult> AddTypedMessageOnceAsync(
        Guid userId,
        Guid conversationId,
        string scope,
        string idempotencyKey,
        string requestHash,
        TypedMessageRequest request,
        CancellationToken cancellationToken)
    {
        await using var transaction = await db.Database.BeginTransactionAsync(cancellationToken);
        var nowMs = timeProvider.GetUtcNow().ToUnixTimeMilliseconds();
        var conversation = await db.Conversations.SingleOrDefaultAsync(
            item => item.Id == conversationId && item.UserId == userId,
            cancellationToken);
        if (conversation is null)
        {
            return new(ConversationStoreResultKind.NotFound);
        }

        await DeleteExpiredIdempotencyRecordAsync(
            userId,
            scope,
            idempotencyKey,
            nowMs,
            cancellationToken);

        var existingMessage = await db.Messages.AsNoTracking().SingleOrDefaultAsync(
            message => message.ConversationId == conversationId
                && message.ClientRequestId == request.ClientRequestId,
            cancellationToken);
        if (existingMessage is not null)
        {
            if (!string.Equals(existingMessage.Text, request.Text, StringComparison.Ordinal))
            {
                return new(
                    ConversationStoreResultKind.Conflict,
                    ConflictDetail: "The clientRequestId was already used with a different payload.");
            }

            var existingResponse = new TypedMessageResponse(existingMessage.Id, existingMessage.Sequence, true);
            db.IdempotencyRecords.Add(CreateIdempotencyRecord(
                userId,
                scope,
                idempotencyKey,
                requestHash,
                StatusCodes.Ok,
                JsonSerializer.Serialize(existingResponse, JsonOptions),
                nowMs));
            await db.SaveChangesAsync(cancellationToken);
            await transaction.CommitAsync(cancellationToken);
            return new(ConversationStoreResultKind.Replayed, existingResponse, ResponseStatus: StatusCodes.Ok);
        }

        var sequence = (await db.Messages
            .Where(message => message.ConversationId == conversationId)
            .Select(message => (long?)message.Sequence)
            .MaxAsync(cancellationToken) ?? 0L) + 1L;
        var messageEntity = Message.CreateTypedUserMessage(
            Guid.CreateVersion7(),
            conversationId,
            request.Text,
            request.ClientRequestId,
            sequence,
            nowMs);
        conversation.RecordActivity(nowMs);
        db.Messages.Add(messageEntity);

        var response = new TypedMessageResponse(messageEntity.Id, messageEntity.Sequence, true);
        db.IdempotencyRecords.Add(CreateIdempotencyRecord(
            userId,
            scope,
            idempotencyKey,
            requestHash,
            StatusCodes.Ok,
            JsonSerializer.Serialize(response, JsonOptions),
            nowMs));
        AddOutbox("message.typed.created", new
        {
            userId,
            conversationId,
            messageId = messageEntity.Id,
            sequence = messageEntity.Sequence
        },
        nowMs);

        await db.SaveChangesAsync(cancellationToken);
        await transaction.CommitAsync(cancellationToken);
        return new(ConversationStoreResultKind.Created, response);
    }

    private void AddOutbox(string eventType, object payload, long nowMs)
    {
        var eventId = Guid.CreateVersion7();
        var payloadJson = JsonSerializer.Serialize(new
        {
            eventId,
            occurredAt = nowMs,
            type = eventType,
            payload
        }, JsonOptions);
        db.OutboxMessages.Add(OutboxMessage.Create(eventId, eventType, payloadJson, nowMs));
    }

    private IdempotencyRecord CreateIdempotencyRecord(
        Guid userId,
        string scope,
        string idempotencyKey,
        string requestHash,
        int responseStatus,
        string responseJson,
        long nowMs)
    {
        return IdempotencyRecord.Create(
            userId,
            scope,
            idempotencyKey,
            requestHash,
            responseStatus,
            responseJson,
            nowMs,
            checked(nowMs + idempotencyOptions.Value.RetentionMs));
    }

    private Task<IdempotencyRecord?> FindIdempotencyRecordAsync(
        Guid userId,
        string scope,
        string idempotencyKey,
        CancellationToken cancellationToken)
    {
        var nowMs = timeProvider.GetUtcNow().ToUnixTimeMilliseconds();
        return db.IdempotencyRecords
            .AsNoTracking()
            .SingleOrDefaultAsync(
                record => record.UserId == userId
                    && record.Scope == scope
                    && record.IdempotencyKey == idempotencyKey
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

    private static ConversationStoreResult ReplayCreate(
        IdempotencyRecord existing,
        string requestHash)
    {
        return ReplayOrConflict<ConversationStoreResult, ConversationResponse>(
            existing,
            requestHash,
            response => new(ConversationStoreResultKind.Replayed, response, ResponseStatus: existing.ResponseStatus),
            detail => new(ConversationStoreResultKind.Conflict, ConflictDetail: detail));
    }

    private static TypedMessageStoreResult ReplayTyped(
        IdempotencyRecord existing,
        string requestHash)
    {
        return ReplayOrConflict<TypedMessageStoreResult, TypedMessageResponse>(
            existing,
            requestHash,
            response => new(ConversationStoreResultKind.Replayed, response, ResponseStatus: existing.ResponseStatus),
            detail => new(ConversationStoreResultKind.Conflict, ConflictDetail: detail));
    }

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

    private static ConversationResponse ToConversationResponse(
        Conversation conversation,
        IEnumerable<Message> messages,
        int messageCount)
    {
        return new(
            conversation.Id,
            conversation.Title,
            ToContractStatus(conversation.Status),
            conversation.LastActivityAtMs,
            conversation.CreatedAtMs,
            messages.Select(ToMessageResponse).ToArray(),
            messageCount);
    }

    private static MessageResponse ToMessageResponse(Message message)
    {
        return new(
            message.Id,
            message.ConversationId,
            ToContractRole(message.Role),
            message.InputModality is { } inputModality ? ToContractInputModality(inputModality) : null,
            message.OutputModality is { } outputModality ? ToContractOutputModality(outputModality) : null,
            message.Text,
            ToContractStatus(message.Status),
            message.ExternalItemId,
            message.ClientRequestId,
            message.Sequence,
            message.StartedAtMs,
            message.CompletedAtMs);
    }

    private static TResult ReplayOrConflict<TResult, TResponse>(
        IdempotencyRecord existing,
        string requestHash,
        Func<TResponse, TResult> replay,
        Func<string, TResult> conflict)
    {
        if (!string.Equals(existing.RequestHash, requestHash, StringComparison.Ordinal))
        {
            return conflict("The Idempotency-Key was already used with a different payload.");
        }

        try
        {
            var response = JsonSerializer.Deserialize<TResponse>(existing.ResponseJson, JsonOptions);
            return response is null
                ? conflict("The stored idempotent response could not be read.")
                : replay(response);
        }
        catch (JsonException)
        {
            return conflict("The stored idempotent response could not be read.");
        }
    }

    private static ConversationStatusValue ToContractStatus(DomainConversationStatus status) => status switch
    {
        DomainConversationStatus.Active => ConversationStatusValue.Active,
        DomainConversationStatus.Archived => ConversationStatusValue.Archived,
        _ => throw new ArgumentOutOfRangeException(nameof(status), status, null)
    };

    private static MessageRoleValue ToContractRole(DomainMessageRole role) => role switch
    {
        DomainMessageRole.User => MessageRoleValue.User,
        DomainMessageRole.Assistant => MessageRoleValue.Assistant,
        DomainMessageRole.Tool => MessageRoleValue.Tool,
        DomainMessageRole.System => MessageRoleValue.System,
        _ => throw new ArgumentOutOfRangeException(nameof(role), role, null)
    };

    private static MessageInputModalityValue ToContractInputModality(DomainInputModality modality) => modality switch
    {
        DomainInputModality.Voice => MessageInputModalityValue.Voice,
        DomainInputModality.TypedText => MessageInputModalityValue.TypedText,
        DomainInputModality.Image => MessageInputModalityValue.Image,
        DomainInputModality.Tool => MessageInputModalityValue.Tool,
        _ => throw new ArgumentOutOfRangeException(nameof(modality), modality, null)
    };

    private static MessageOutputModalityValue ToContractOutputModality(DomainMessageOutputModality modality) => modality switch
    {
        DomainMessageOutputModality.Audio => MessageOutputModalityValue.Audio,
        DomainMessageOutputModality.Text => MessageOutputModalityValue.Text,
        DomainMessageOutputModality.AudioWithTranscript => MessageOutputModalityValue.AudioWithTranscript,
        _ => throw new ArgumentOutOfRangeException(nameof(modality), modality, null)
    };

    private static MessageStatusValue ToContractStatus(DomainMessageStatus status) => status switch
    {
        DomainMessageStatus.Pending => MessageStatusValue.Pending,
        DomainMessageStatus.Streaming => MessageStatusValue.Streaming,
        DomainMessageStatus.Completed => MessageStatusValue.Completed,
        DomainMessageStatus.Interrupted => MessageStatusValue.Interrupted,
        DomainMessageStatus.Failed => MessageStatusValue.Failed,
        _ => throw new ArgumentOutOfRangeException(nameof(status), status, null)
    };

    private static class StatusCodes
    {
        public const int Ok = 200;
        public const int Created = 201;
    }

}
