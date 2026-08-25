using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Jarvis.Contracts;

namespace Jarvis.Application.Conversations;

public enum ConversationOperationStatus
{
    Succeeded,
    Replayed,
    Conflict,
    Invalid,
    NotFound
}

public sealed record ConversationOperation<T>(
    ConversationOperationStatus Status,
    T? Value = default,
    string? Detail = null,
    int ResponseStatus = 200);

public sealed class ConversationService(IConversationStore store)
{
    private const int MaxIdempotencyKeyLength = 200;
    private const int MaxClientRequestIdLength = 200;
    private const int MaxMessageLength = 100_000;

    public async Task<ConversationOperation<ConversationResponse>> CreateAsync(
        Guid userId,
        string? idempotencyKey,
        CreateConversationRequest request,
        CancellationToken cancellationToken)
    {
        if (string.IsNullOrWhiteSpace(idempotencyKey))
        {
            return Invalid<ConversationResponse>("The Idempotency-Key header is required.");
        }

        var normalizedIdempotencyKey = idempotencyKey.Trim();
        if (normalizedIdempotencyKey.Length > MaxIdempotencyKeyLength)
        {
            return Invalid<ConversationResponse>("The Idempotency-Key header is too long.");
        }

        if (request.Title is { Length: > 500 })
        {
            return Invalid<ConversationResponse>("The conversation title must be 500 characters or fewer.");
        }

        var hash = RequestHash.Create(request);
        var result = await store.CreateAsync(
            userId,
            normalizedIdempotencyKey,
            hash,
            request,
            cancellationToken);

        return result.Kind switch
        {
            ConversationStoreResultKind.Created => new(ConversationOperationStatus.Succeeded, result.Response, ResponseStatus: result.ResponseStatus),
            ConversationStoreResultKind.Replayed => new(ConversationOperationStatus.Replayed, result.Response, ResponseStatus: result.ResponseStatus),
            ConversationStoreResultKind.NotFound => new(ConversationOperationStatus.NotFound),
            _ => new(ConversationOperationStatus.Conflict, Detail: result.ConflictDetail)
        };
    }

    public async Task<ConversationOperation<ConversationResponse>> GetAsync(
        Guid userId,
        Guid conversationId,
        CancellationToken cancellationToken)
    {
        var response = await store.GetAsync(userId, conversationId, cancellationToken);
        return response is null
            ? new(ConversationOperationStatus.NotFound)
            : new(ConversationOperationStatus.Succeeded, response);
    }

    public async Task<ConversationOperation<MessagePageResponse>> GetMessagesAsync(
        Guid userId,
        Guid conversationId,
        long? cursor,
        int limit,
        CancellationToken cancellationToken)
    {
        if (limit is < 1 or > 100)
        {
            return Invalid<MessagePageResponse>("The limit must be between 1 and 100.");
        }

        if (cursor is < 1)
        {
            return Invalid<MessagePageResponse>("The cursor must be a positive message sequence.");
        }

        var response = await store.GetMessagesAsync(
            userId,
            conversationId,
            cursor,
            limit,
            cancellationToken);
        return response is null
            ? new(ConversationOperationStatus.NotFound)
            : new(ConversationOperationStatus.Succeeded, response);
    }

    public async Task<ConversationOperation<TypedMessageResponse>> AddTypedMessageAsync(
        Guid userId,
        Guid conversationId,
        string? idempotencyKey,
        TypedMessageRequest request,
        CancellationToken cancellationToken)
    {
        if (string.IsNullOrWhiteSpace(idempotencyKey))
        {
            return Invalid<TypedMessageResponse>("The Idempotency-Key header is required.");
        }

        var normalizedIdempotencyKey = idempotencyKey.Trim();
        if (normalizedIdempotencyKey.Length > MaxIdempotencyKeyLength)
        {
            return Invalid<TypedMessageResponse>("The Idempotency-Key header is too long.");
        }

        if (string.IsNullOrWhiteSpace(request.ClientRequestId))
        {
            return Invalid<TypedMessageResponse>("The clientRequestId is required.");
        }

        var normalizedClientRequestId = request.ClientRequestId.Trim();
        if (normalizedClientRequestId.Length > MaxClientRequestIdLength)
        {
            return Invalid<TypedMessageResponse>("The clientRequestId is too long.");
        }

        request = request with { ClientRequestId = normalizedClientRequestId };

        if (string.IsNullOrWhiteSpace(request.Text))
        {
            return Invalid<TypedMessageResponse>("The text is required.");
        }

        if (request.Text.Length > MaxMessageLength)
        {
            return Invalid<TypedMessageResponse>("The message text is too long.");
        }

        if (!string.Equals(request.ReplyMode, "text", StringComparison.OrdinalIgnoreCase))
        {
            return Invalid<TypedMessageResponse>("Only text reply mode is supported in Phase 1.");
        }

        var hash = RequestHash.Create(request);
        var result = await store.AddTypedMessageAsync(
            userId,
            conversationId,
            normalizedIdempotencyKey,
            hash,
            request,
            cancellationToken);

        return result.Kind switch
        {
            ConversationStoreResultKind.Created => new(ConversationOperationStatus.Succeeded, result.Response, ResponseStatus: result.ResponseStatus),
            ConversationStoreResultKind.Replayed => new(ConversationOperationStatus.Replayed, result.Response, ResponseStatus: result.ResponseStatus),
            ConversationStoreResultKind.NotFound => new(ConversationOperationStatus.NotFound),
            _ => new(ConversationOperationStatus.Conflict, Detail: result.ConflictDetail)
        };
    }

    private static ConversationOperation<T> Invalid<T>(string detail)
    {
        return new(ConversationOperationStatus.Invalid, Detail: detail);
    }

    private static class RequestHash
    {
        private static readonly JsonSerializerOptions Options = new(JsonSerializerDefaults.Web);

        public static string Create<T>(T request)
        {
            var json = JsonSerializer.Serialize(request, Options);
            return Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(json)));
        }
    }

    private static class StatusCodes
    {
        public const int Ok = 200;
    }
}
