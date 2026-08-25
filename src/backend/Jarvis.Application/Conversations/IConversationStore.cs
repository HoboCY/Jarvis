using Jarvis.Contracts;

namespace Jarvis.Application.Conversations;

public enum ConversationStoreResultKind
{
    Created,
    Replayed,
    Conflict,
    NotFound
}

public sealed record ConversationStoreResult(
    ConversationStoreResultKind Kind,
    ConversationResponse? Response = null,
    string? ConflictDetail = null,
    int ResponseStatus = 201);

public sealed record TypedMessageStoreResult(
    ConversationStoreResultKind Kind,
    TypedMessageResponse? Response = null,
    string? ConflictDetail = null,
    int ResponseStatus = 200);

public interface IConversationStore
{
    Task<ConversationStoreResult> CreateAsync(
        Guid userId,
        string idempotencyKey,
        string requestHash,
        CreateConversationRequest request,
        CancellationToken cancellationToken);

    Task<ConversationResponse?> GetAsync(
        Guid userId,
        Guid conversationId,
        CancellationToken cancellationToken);

    Task<MessagePageResponse?> GetMessagesAsync(
        Guid userId,
        Guid conversationId,
        long? cursor,
        int limit,
        CancellationToken cancellationToken);

    Task<TypedMessageStoreResult> AddTypedMessageAsync(
        Guid userId,
        Guid conversationId,
        string idempotencyKey,
        string requestHash,
        TypedMessageRequest request,
        CancellationToken cancellationToken);
}
