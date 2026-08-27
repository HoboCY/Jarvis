using System.Data.Common;
using System.Text.Json;
using Jarvis.Application.Notifications;
using Jarvis.Contracts;
using Jarvis.Domain.Idempotency;
using Jarvis.Domain.Notifications;
using Jarvis.Domain.Outbox;
using Jarvis.Infrastructure.Data;
using Jarvis.Infrastructure.Idempotency;
using Jarvis.Infrastructure.Observability;
using Microsoft.Data.Sqlite;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Options;
using DomainNotificationStatus = Jarvis.Domain.Notifications.NotificationStatus;

namespace Jarvis.Infrastructure.Notifications;

public sealed class EfNotificationStore(
    JarvisDbContext db,
    TimeProvider timeProvider,
    IOptions<IdempotencyOptions> idempotencyOptions) : INotificationStore
{
    private static readonly JsonSerializerOptions JsonOptions = new(JsonSerializerDefaults.Web);
    private const int MaxWriteAttempts = 5;

    public async Task<NotificationListResponse> ListUnreadAsync(
        Guid userId,
        Guid? conversationId,
        CancellationToken cancellationToken)
    {
        var query = db.Notifications
            .AsNoTracking()
            .Where(notification => notification.UserId == userId
                && (notification.Status == DomainNotificationStatus.Pending
                    || notification.Status == DomainNotificationStatus.Delivered));
        if (conversationId is Guid id)
        {
            query = query.Where(notification => notification.ConversationId == id);
        }

        var notifications = await query
            .OrderByDescending(notification => notification.CreatedAtMs)
            .ToListAsync(cancellationToken);
        return new NotificationListResponse(notifications.Select(ToResponse).ToArray());
    }

    public async Task<NotificationUpdateStoreResult> UpdateAsync(
        Guid userId,
        Guid notificationId,
        string action,
        string idempotencyKey,
        string requestHash,
        CancellationToken cancellationToken)
    {
        var scope = $"notifications:{notificationId}:{action}";
        var existing = await FindIdempotencyRecordAsync(userId, scope, idempotencyKey, cancellationToken);
        if (existing is not null)
        {
            var replay = Replay(existing, requestHash);
            RecordDuplicateIfReplayed(replay, "replay");
            return replay;
        }

        for (var attempt = 1; ; attempt++)
        {
            try
            {
                return await UpdateOnceAsync(
                    userId,
                    notificationId,
                    action,
                    scope,
                    idempotencyKey,
                    requestHash,
                    cancellationToken);
            }
            catch (Exception exception) when (attempt < MaxWriteAttempts && IsRecognizedWriteRace(exception))
            {
                db.ChangeTracker.Clear();
                try
                {
                    existing = await FindIdempotencyRecordAsync(userId, scope, idempotencyKey, cancellationToken);
                }
                catch (Exception lookupException) when (IsRecognizedWriteRace(lookupException))
                {
                    existing = null;
                }
                if (existing is not null)
                {
                    var replay = Replay(existing, requestHash);
                    RecordDuplicateIfReplayed(replay, "race_replay");
                    return replay;
                }

                await Task.Delay(TimeSpan.FromMilliseconds(10L * attempt), cancellationToken);
            }
        }
    }

    public async Task<NotificationUpdateStoreResult> ApplyActionAsync(
        Guid userId,
        Guid notificationId,
        string actionId,
        string idempotencyKey,
        string requestHash,
        CancellationToken cancellationToken)
    {
        var scope = $"notifications:{notificationId}:actions:{actionId}";
        var existing = await FindIdempotencyRecordAsync(userId, scope, idempotencyKey, cancellationToken);
        if (existing is not null)
        {
            var replay = Replay(existing, requestHash);
            RecordDuplicateIfReplayed(replay, "action_replay");
            return replay;
        }

        for (var attempt = 1; ; attempt++)
        {
            try
            {
                return await ApplyActionOnceAsync(
                    userId,
                    notificationId,
                    actionId,
                    scope,
                    idempotencyKey,
                    requestHash,
                    cancellationToken);
            }
            catch (Exception exception) when (attempt < MaxWriteAttempts && IsRecognizedWriteRace(exception))
            {
                db.ChangeTracker.Clear();
                try
                {
                    existing = await FindIdempotencyRecordAsync(userId, scope, idempotencyKey, cancellationToken);
                }
                catch (Exception lookupException) when (IsRecognizedWriteRace(lookupException))
                {
                    existing = null;
                }
                if (existing is not null)
                {
                    var replay = Replay(existing, requestHash);
                    RecordDuplicateIfReplayed(replay, "action_race_replay");
                    return replay;
                }

                await Task.Delay(TimeSpan.FromMilliseconds(10L * attempt), cancellationToken);
            }
        }
    }

    private async Task<NotificationUpdateStoreResult> UpdateOnceAsync(
        Guid userId,
        Guid notificationId,
        string action,
        string scope,
        string idempotencyKey,
        string requestHash,
        CancellationToken cancellationToken)
    {
        await using var transaction = await db.Database.BeginTransactionAsync(cancellationToken);
        var nowMs = timeProvider.GetUtcNow().ToUnixTimeMilliseconds();
        await DeleteExpiredIdempotencyRecordAsync(userId, scope, idempotencyKey, nowMs, cancellationToken);
        var existing = await FindIdempotencyRecordAsync(userId, scope, idempotencyKey, cancellationToken);
        if (existing is not null)
        {
            return Replay(existing, requestHash);
        }

        var notification = await db.Notifications.SingleOrDefaultAsync(
            item => item.Id == notificationId && item.UserId == userId,
            cancellationToken);
        if (notification is null)
        {
            return new(NotificationStoreResultKind.NotFound);
        }

        bool changed;
        try
        {
            changed = action switch
            {
                "delivered" => notification.MarkDelivered(nowMs),
                "read" => notification.MarkRead(nowMs),
                "dismiss" => notification.MarkDismissed(nowMs),
                _ => throw new ArgumentOutOfRangeException(nameof(action))
            };
        }
        catch (InvalidOperationException exception)
        {
            return new(NotificationStoreResultKind.Conflict, Detail: exception.Message);
        }

        var response = ToResponse(notification);
        if (changed)
        {
            AddOutbox("notification.updated", new
            {
                userId,
                notificationId = notification.Id,
                taskId = notification.TaskId,
                conversationId = notification.ConversationId,
                status = JsonNamingPolicy.CamelCase.ConvertName(notification.Status.ToString()),
                title = notification.Title,
                body = notification.Body,
                type = notification.Type,
                actionsJson = notification.ActionsJson,
                dedupKey = notification.DedupKey,
                action,
                entityVersion = notification.Version
            }, nowMs);
        }

        db.IdempotencyRecords.Add(IdempotencyRecord.Create(
            userId,
            scope,
            idempotencyKey,
            requestHash,
            200,
            JsonSerializer.Serialize(response, JsonOptions),
            nowMs,
            checked(nowMs + idempotencyOptions.Value.RetentionMs)));
        await db.SaveChangesAsync(cancellationToken);
        await transaction.CommitAsync(cancellationToken);
        return new(NotificationStoreResultKind.Updated, response);
    }

    private async Task<NotificationUpdateStoreResult> ApplyActionOnceAsync(
        Guid userId,
        Guid notificationId,
        string actionId,
        string scope,
        string idempotencyKey,
        string requestHash,
        CancellationToken cancellationToken)
    {
        await using var transaction = await db.Database.BeginTransactionAsync(cancellationToken);
        var nowMs = timeProvider.GetUtcNow().ToUnixTimeMilliseconds();
        await DeleteExpiredIdempotencyRecordAsync(userId, scope, idempotencyKey, nowMs, cancellationToken);
        var existing = await FindIdempotencyRecordAsync(userId, scope, idempotencyKey, cancellationToken);
        if (existing is not null)
        {
            return Replay(existing, requestHash);
        }

        var notification = await db.Notifications.SingleOrDefaultAsync(
            item => item.Id == notificationId && item.UserId == userId,
            cancellationToken);
        if (notification is null)
        {
            return new(NotificationStoreResultKind.NotFound);
        }

        var actionResult = notification.ApplyAction(actionId, nowMs);
        if (actionResult == NotificationActionResult.UnknownAction)
        {
            return new(NotificationStoreResultKind.Invalid, Detail: "The notification action is invalid.");
        }

        if (actionResult == NotificationActionResult.NotOffered)
        {
            return new(NotificationStoreResultKind.NotOffered, Detail: "This notification does not offer that action.");
        }

        if (actionResult == NotificationActionResult.InvalidState)
        {
            return new(NotificationStoreResultKind.Conflict, Detail: $"A notification in {notification.Status} cannot be actioned.");
        }

        var response = ToResponse(notification);
        AddOutbox("notification.updated", new
        {
            userId,
            notificationId = notification.Id,
            taskId = notification.TaskId,
            conversationId = notification.ConversationId,
            status = JsonNamingPolicy.CamelCase.ConvertName(notification.Status.ToString()),
            title = notification.Title,
            body = notification.Body,
            type = notification.Type,
            actionsJson = notification.ActionsJson,
            dedupKey = notification.DedupKey,
            action = actionId,
            entityVersion = notification.Version
        }, nowMs);

        db.IdempotencyRecords.Add(IdempotencyRecord.Create(
            userId,
            scope,
            idempotencyKey,
            requestHash,
            200,
            JsonSerializer.Serialize(response, JsonOptions),
            nowMs,
            checked(nowMs + idempotencyOptions.Value.RetentionMs)));
        await db.SaveChangesAsync(cancellationToken);
        await transaction.CommitAsync(cancellationToken);
        return new(NotificationStoreResultKind.Updated, response);
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
        JarvisTelemetry.RecordOutboxEnqueued(eventType);
    }

    private static void RecordDuplicateIfReplayed(
        NotificationUpdateStoreResult result,
        string operation)
    {
        if (result.Kind == NotificationStoreResultKind.Replayed)
        {
            JarvisTelemetry.DuplicateNotificationsSuppressed.Add(
                1,
                JarvisTelemetry.BoundedTags(("operation", operation)).ToArray());
        }
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
        string key,
        long nowMs,
        CancellationToken cancellationToken)
    {
        return db.IdempotencyRecords
            .Where(record => record.UserId == userId
                && record.Scope == scope
                && record.IdempotencyKey == key
                && record.ExpiresAtMs <= nowMs)
            .ExecuteDeleteAsync(cancellationToken);
    }

    private static NotificationUpdateStoreResult Replay(IdempotencyRecord existing, string requestHash)
    {
        if (!string.Equals(existing.RequestHash, requestHash, StringComparison.Ordinal))
        {
            return new(NotificationStoreResultKind.Conflict, Detail: "The Idempotency-Key was already used with a different payload.");
        }

        try
        {
            var response = JsonSerializer.Deserialize<NotificationResponse>(existing.ResponseJson, JsonOptions);
            return response is null
                ? new(NotificationStoreResultKind.Conflict, Detail: "The stored idempotent response could not be read.")
                : new(NotificationStoreResultKind.Replayed, response);
        }
        catch (JsonException)
        {
            return new(NotificationStoreResultKind.Conflict, Detail: "The stored idempotent response could not be read.");
        }
    }

    private static bool IsRecognizedWriteRace(Exception exception)
    {
        for (var current = exception; current is not null; current = current.InnerException)
        {
            if (current is DbUpdateConcurrencyException)
            {
                return true;
            }

            if (current is SqliteException sqlite
                && (sqlite.SqliteErrorCode is 5 or 6
                    || sqlite.SqliteErrorCode == 19 && sqlite.Message.Contains("UNIQUE", StringComparison.OrdinalIgnoreCase)))
            {
                return true;
            }

            if (current is DbException databaseException
                && (databaseException.Message.Contains("BUSY", StringComparison.OrdinalIgnoreCase)
                    || databaseException.Message.Contains("LOCKED", StringComparison.OrdinalIgnoreCase)
                    || databaseException.Message.Contains("UNIQUE", StringComparison.OrdinalIgnoreCase)))
            {
                return true;
            }
        }

        return false;
    }

    private static NotificationResponse ToResponse(Jarvis.Domain.Notifications.Notification notification)
    {
        return new NotificationResponse(
            notification.Id,
            notification.ConversationId,
            notification.TaskId,
            notification.Type,
            notification.Severity switch
            {
                NotificationSeverity.Info => NotificationSeverityValue.Info,
                NotificationSeverity.Success => NotificationSeverityValue.Success,
                NotificationSeverity.Warning => NotificationSeverityValue.Warning,
                NotificationSeverity.Error => NotificationSeverityValue.Error,
                _ => throw new InvalidOperationException("Unknown notification severity.")
            },
            notification.Title,
            notification.Body,
            notification.ActionsJson,
            notification.DedupKey,
            notification.Status switch
            {
                DomainNotificationStatus.Pending => NotificationStatusValue.Pending,
                DomainNotificationStatus.Delivered => NotificationStatusValue.Delivered,
                DomainNotificationStatus.Read => NotificationStatusValue.Read,
                DomainNotificationStatus.Actioned => NotificationStatusValue.Actioned,
                DomainNotificationStatus.Dismissed => NotificationStatusValue.Dismissed,
                _ => throw new InvalidOperationException("Unknown notification status.")
            },
            notification.Version,
            notification.CreatedAtMs,
            notification.DeliveredAtMs,
            notification.ReadAtMs,
            notification.ActionedAtMs,
            notification.ApprovalId);
    }
}
