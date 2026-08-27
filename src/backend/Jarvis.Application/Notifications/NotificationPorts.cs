using Jarvis.Contracts;

namespace Jarvis.Application.Notifications;

public enum NotificationStoreResultKind
{
    Updated,
    Replayed,
    Conflict,
    Invalid,
    NotOffered,
    NotFound
}

public sealed record NotificationUpdateStoreResult(
    NotificationStoreResultKind Kind,
    NotificationResponse? Response = null,
    string? Detail = null);

public interface INotificationStore
{
    Task<NotificationListResponse> ListUnreadAsync(
        Guid userId,
        Guid? conversationId,
        CancellationToken cancellationToken);

    Task<NotificationUpdateStoreResult> UpdateAsync(
        Guid userId,
        Guid notificationId,
        string action,
        string idempotencyKey,
        string requestHash,
        CancellationToken cancellationToken);

    Task<NotificationUpdateStoreResult> ApplyActionAsync(
        Guid userId,
        Guid notificationId,
        string actionId,
        string idempotencyKey,
        string requestHash,
        CancellationToken cancellationToken);
}
