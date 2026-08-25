using Jarvis.Contracts;

namespace Jarvis.Application.Notifications;

public enum NotificationStoreResultKind
{
    Updated,
    Replayed,
    Conflict,
    Invalid,
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
}
