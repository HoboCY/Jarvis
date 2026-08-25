using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Jarvis.Contracts;

namespace Jarvis.Application.Notifications;

public enum NotificationOperationStatus
{
    Succeeded,
    Replayed,
    Conflict,
    Invalid,
    NotFound
}

public sealed record NotificationOperation<T>(
    NotificationOperationStatus Status,
    T? Value = default,
    string? Detail = null);

public sealed class NotificationService(INotificationStore store)
{
    public Task<NotificationOperation<NotificationListResponse>> ListUnreadAsync(
        Guid userId,
        Guid? conversationId,
        CancellationToken cancellationToken)
    {
        if (conversationId is Guid id && id == Guid.Empty)
        {
            return System.Threading.Tasks.Task.FromResult(
                Invalid<NotificationListResponse>("conversationId is invalid."));
        }

        return ListCoreAsync(userId, conversationId, cancellationToken);
    }

    private async Task<NotificationOperation<NotificationListResponse>> ListCoreAsync(
        Guid userId,
        Guid? conversationId,
        CancellationToken cancellationToken)
    {
        var response = await store.ListUnreadAsync(userId, conversationId, cancellationToken);
        return new(NotificationOperationStatus.Succeeded, response);
    }

    public async Task<NotificationOperation<NotificationResponse>> UpdateAsync(
        Guid userId,
        Guid notificationId,
        string action,
        string? idempotencyKey,
        CancellationToken cancellationToken)
    {
        if (notificationId == Guid.Empty)
        {
            return Invalid<NotificationResponse>("notificationId is required.");
        }

        if (string.IsNullOrWhiteSpace(idempotencyKey))
        {
            return Invalid<NotificationResponse>("The Idempotency-Key header is required.");
        }

        var key = idempotencyKey.Trim();
        if (key.Length > 200)
        {
            return Invalid<NotificationResponse>("The Idempotency-Key header is too long.");
        }

        if (action is not ("delivered" or "read" or "dismiss"))
        {
            return Invalid<NotificationResponse>("The notification action is invalid.");
        }

        var requestHash = Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes($"{notificationId:D}:{action}")));
        var result = await store.UpdateAsync(
            userId,
            notificationId,
            action,
            key,
            requestHash,
            cancellationToken);
        return result.Kind switch
        {
            NotificationStoreResultKind.Updated => new(NotificationOperationStatus.Succeeded, result.Response),
            NotificationStoreResultKind.Replayed => new(NotificationOperationStatus.Replayed, result.Response),
            NotificationStoreResultKind.NotFound => new(NotificationOperationStatus.NotFound),
            NotificationStoreResultKind.Invalid => Invalid<NotificationResponse>(result.Detail ?? "Invalid notification update."),
            _ => new(NotificationOperationStatus.Conflict, Detail: result.Detail ?? "The notification update conflicts with its current state.")
        };
    }

    private static NotificationOperation<T> Invalid<T>(string detail) => new(NotificationOperationStatus.Invalid, Detail: detail);
}
