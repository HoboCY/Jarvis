using System.Data.Common;
using System.Text.Json;
using Jarvis.Application.Tasks;
using Jarvis.Contracts;
using Jarvis.Domain.Conversations;
using Jarvis.Domain.Idempotency;
using Jarvis.Domain.Notifications;
using Jarvis.Domain.Outbox;
using Jarvis.Infrastructure.Data;
using Jarvis.Infrastructure.Idempotency;
using Microsoft.Data.Sqlite;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Options;
using DomainTask = Jarvis.Domain.Tasks.Task;
using DomainTaskStatus = Jarvis.Domain.Tasks.TaskStatus;
using DomainTaskEvent = Jarvis.Domain.Tasks.TaskEvent;
using DomainWorkerKind = Jarvis.Domain.Tasks.WorkerKind;

namespace Jarvis.Infrastructure.Tasks;

public sealed class EfTaskStore(
    JarvisDbContext db,
    TimeProvider timeProvider,
    IOptions<IdempotencyOptions> idempotencyOptions) : ITaskStore
{
    private static readonly JsonSerializerOptions JsonOptions = new(JsonSerializerDefaults.Web);
    private const int MaxWriteAttempts = 5;
    private const string StateConflictDetail = "The task cannot be cancelled from its current state.";

    public async Task<TaskCreateStoreResult> CreateAsync(
        Guid userId,
        string idempotencyKey,
        string requestHash,
        CreateTaskRequest request,
        IReadOnlyList<string> capabilities,
        DomainWorkerKind workerKind,
        CancellationToken cancellationToken)
    {
        const string scope = "tasks:create";
        var existing = await FindIdempotencyRecordAsync(userId, scope, idempotencyKey, cancellationToken);
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
                    capabilities,
                    workerKind,
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
                    return ReplayCreate(existing, requestHash);
                }

                await Task.Delay(TimeSpan.FromMilliseconds(10L * attempt), cancellationToken);
            }
        }
    }

    private async Task<TaskCreateStoreResult> CreateOnceAsync(
        Guid userId,
        string scope,
        string idempotencyKey,
        string requestHash,
        CreateTaskRequest request,
        IReadOnlyList<string> capabilities,
        DomainWorkerKind workerKind,
        CancellationToken cancellationToken)
    {
        await using var transaction = await db.Database.BeginTransactionAsync(cancellationToken);
        var nowMs = timeProvider.GetUtcNow().ToUnixTimeMilliseconds();
        await DeleteExpiredIdempotencyRecordAsync(userId, scope, idempotencyKey, nowMs, cancellationToken);

        var conversation = await db.Conversations.SingleOrDefaultAsync(
            item => item.Id == request.ConversationId && item.UserId == userId,
            cancellationToken);
        if (conversation is null)
        {
            return new(TaskStoreResultKind.NotFound);
        }

        var sourceMessageIds = request.SourceMessageIds ?? Array.Empty<Guid>();
        if (sourceMessageIds.Count > 0)
        {
            var ownedMessageCount = await db.Messages.CountAsync(
                message => message.ConversationId == request.ConversationId
                    && sourceMessageIds.Contains(message.Id),
                cancellationToken);
            if (ownedMessageCount != sourceMessageIds.Count)
            {
                return new(TaskStoreResultKind.Invalid, Detail: "Every sourceMessageId must belong to the conversation.");
            }
        }

        if (request.PreferredDeviceId is Guid preferredDeviceId
            && !await db.Devices.AnyAsync(
                device => device.Id == preferredDeviceId && device.UserId == userId,
                cancellationToken))
        {
            return new(TaskStoreResultKind.Invalid, Detail: "preferredDeviceId must belong to the current user.");
        }

        var task = DomainTask.Create(
            Guid.CreateVersion7(),
            userId,
            request.ConversationId,
            request.Goal,
            request.ExpectedOutput,
            JsonSerializer.Serialize(capabilities, JsonOptions),
            JsonSerializer.Serialize(request.AttachmentRefs ?? Array.Empty<string>(), JsonOptions),
            request.PreferredDeviceId,
            workerKind,
            priority: 0,
            nowMs,
            sourceMessageIds.Count > 0 ? sourceMessageIds[0] : null);
        db.Tasks.Add(task);

        var accepted = new TaskAcceptedResponse(
            true,
            task.Id,
            ToContractStatus(task.Status),
            ToContractWorkerKind(task.WorkerKind));
        AddTaskEventAndOutbox(task, "task.created", nowMs);
        db.IdempotencyRecords.Add(CreateIdempotencyRecord(
            userId,
            scope,
            idempotencyKey,
            requestHash,
            StatusCodes.Accepted,
            JsonSerializer.Serialize(accepted, JsonOptions),
            nowMs));

        await db.SaveChangesAsync(cancellationToken);
        await transaction.CommitAsync(cancellationToken);
        return new(TaskStoreResultKind.Created, accepted);
    }

    public async Task<TaskResponse?> GetAsync(
        Guid userId,
        Guid taskId,
        CancellationToken cancellationToken)
    {
        var task = await db.Tasks.AsNoTracking().SingleOrDefaultAsync(
            item => item.Id == taskId && item.UserId == userId,
            cancellationToken);
        return task is null ? null : ToResponse(task);
    }

    public async Task<TaskListResponse?> ListAsync(
        Guid userId,
        Guid? conversationId,
        TaskStatusValue? status,
        TaskListCursor? cursor,
        int limit,
        CancellationToken cancellationToken)
    {
        var query = db.Tasks.AsNoTracking().Where(task => task.UserId == userId);
        if (conversationId is Guid conversation)
        {
            query = query.Where(task => task.ConversationId == conversation);
        }

        if (status is TaskStatusValue taskStatus)
        {
            query = query.Where(task => task.Status == ToDomainStatus(taskStatus));
        }

        if (cursor is TaskListCursor decodedCursor)
        {
            query = query.Where(task => task.CreatedAtMs < decodedCursor.CreatedAtMs
                || task.CreatedAtMs == decodedCursor.CreatedAtMs
                    && task.Id.CompareTo(decodedCursor.Id) < 0);
        }

        var tasks = await query
            .OrderByDescending(task => task.CreatedAtMs)
            .ThenByDescending(task => task.Id)
            .Take(limit + 1)
            .ToListAsync(cancellationToken);
        var hasMore = tasks.Count > limit;
        if (hasMore)
        {
            tasks.RemoveAt(tasks.Count - 1);
        }

        var nextCursor = hasMore
            ? new TaskListCursor(tasks[^1].CreatedAtMs, tasks[^1].Id).Encode()
            : null;
        return new TaskListResponse(tasks.Select(ToResponse).ToArray(), nextCursor);
    }

    public async Task<TaskCancelStoreResult> CancelAsync(
        Guid userId,
        Guid taskId,
        string idempotencyKey,
        string requestHash,
        CancellationToken cancellationToken)
    {
        var scope = $"tasks:{taskId}:cancel";
        var existing = await FindIdempotencyRecordAsync(userId, scope, idempotencyKey, cancellationToken);
        if (existing is not null)
        {
            return ReplayCancel(existing, requestHash);
        }

        for (var attempt = 1; ; attempt++)
        {
            try
            {
                return await CancelOnceAsync(
                    userId,
                    taskId,
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
                    return ReplayCancel(existing, requestHash);
                }

                await Task.Delay(TimeSpan.FromMilliseconds(10L * attempt), cancellationToken);
            }
        }
    }

    private async Task<TaskCancelStoreResult> CancelOnceAsync(
        Guid userId,
        Guid taskId,
        string scope,
        string idempotencyKey,
        string requestHash,
        CancellationToken cancellationToken)
    {
        await using var transaction = await db.Database.BeginTransactionAsync(cancellationToken);
        var nowMs = timeProvider.GetUtcNow().ToUnixTimeMilliseconds();
        await DeleteExpiredIdempotencyRecordAsync(userId, scope, idempotencyKey, nowMs, cancellationToken);
        var task = await db.Tasks.SingleOrDefaultAsync(
            item => item.Id == taskId && item.UserId == userId,
            cancellationToken);
        if (task is null)
        {
            return new(TaskStoreResultKind.NotFound);
        }

        bool changed;
        try
        {
            changed = task.RequestCancellation(nowMs);
        }
        catch (InvalidOperationException)
        {
            var conflictResponse = new TaskCancelResponse(
                task.Id,
                false,
                ToContractStatus(task.Status));
            db.IdempotencyRecords.Add(CreateIdempotencyRecord(
                userId,
                scope,
                idempotencyKey,
                requestHash,
                StatusCodes.Conflict,
                JsonSerializer.Serialize(conflictResponse, JsonOptions),
                nowMs));
            await db.SaveChangesAsync(cancellationToken);
            await transaction.CommitAsync(cancellationToken);
            return new(TaskStoreResultKind.StateConflict, conflictResponse, StateConflictDetail);
        }

        var response = new TaskCancelResponse(task.Id, changed, ToContractStatus(task.Status));
        if (changed)
        {
            AddTaskEventAndOutbox(task, "task.cancellationRequested", nowMs);
            if (task.Status == DomainTaskStatus.Cancelled)
            {
                AddTerminalNotification(task, "task.cancelled", NotificationSeverity.Info, "后台任务已取消", "Queued task was cancelled before execution.", nowMs);
            }
        }

        db.IdempotencyRecords.Add(CreateIdempotencyRecord(
            userId,
            scope,
            idempotencyKey,
            requestHash,
            StatusCodes.Ok,
            JsonSerializer.Serialize(response, JsonOptions),
            nowMs));
        await db.SaveChangesAsync(cancellationToken);
        await transaction.CommitAsync(cancellationToken);
        return new(TaskStoreResultKind.Created, response);
    }

    public void AddTerminalNotification(
        DomainTask task,
        string type,
        NotificationSeverity severity,
        string title,
        string body,
        long nowMs)
    {
        var dedupKey = $"task:{task.Id:D}:{type}";
        if (db.Notifications.Any(notification => notification.UserId == task.UserId && notification.DedupKey == dedupKey))
        {
            return;
        }

        var notification = Notification.Create(
            Guid.CreateVersion7(),
            task.UserId,
            task.ConversationId,
            task.Id,
            type,
            severity,
            title,
            body,
            dedupKey,
            nowMs);
        db.Notifications.Add(notification);
        AddOutbox("notification.created", new
        {
            userId = task.UserId,
            notificationId = notification.Id,
            taskId = task.Id,
            conversationId = task.ConversationId,
            type,
            severity = JsonNamingPolicy.CamelCase.ConvertName(severity.ToString()),
            title,
            body,
            status = "pending",
            dedupKey,
            entityVersion = notification.Version
        }, nowMs);
    }

    public void AddTaskEventAndOutbox(DomainTask task, string eventType, long nowMs)
    {
        var persistedSequence = db.TaskEvents
            .Where(taskEvent => taskEvent.TaskId == task.Id)
            .Select(taskEvent => (long?)taskEvent.Sequence)
            .Max() ?? 0L;
        var pendingSequence = db.ChangeTracker
            .Entries<DomainTaskEvent>()
            .Count(entry => entry.State == EntityState.Added && entry.Entity.TaskId == task.Id);
        var sequence = persistedSequence + pendingSequence + 1L;
        var payload = new
        {
            userId = task.UserId,
            conversationId = task.ConversationId,
            taskId = task.Id,
            status = JsonNamingPolicy.CamelCase.ConvertName(task.Status.ToString()),
            eventType,
            occurredAt = nowMs,
            entityVersion = task.Version
        };
        db.TaskEvents.Add(DomainTaskEvent.Create(
            Guid.CreateVersion7(),
            task.Id,
            sequence,
            eventType,
            JsonSerializer.Serialize(payload, JsonOptions),
            nowMs));
        AddOutbox("task.updated", payload, nowMs);
        AddOutbox("task.eventAdded", payload, nowMs);
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
        string key,
        string requestHash,
        int responseStatus,
        string responseJson,
        long nowMs)
    {
        return IdempotencyRecord.Create(
            userId,
            scope,
            key,
            requestHash,
            responseStatus,
            responseJson,
            nowMs,
            checked(nowMs + idempotencyOptions.Value.RetentionMs));
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

    private static TaskCreateStoreResult ReplayCreate(IdempotencyRecord existing, string requestHash)
    {
        if (!string.Equals(existing.RequestHash, requestHash, StringComparison.Ordinal))
        {
            return new(TaskStoreResultKind.Conflict, Detail: "The Idempotency-Key was already used with a different payload.");
        }

        try
        {
            var response = JsonSerializer.Deserialize<TaskAcceptedResponse>(existing.ResponseJson, JsonOptions);
            return response is null
                ? new(TaskStoreResultKind.Conflict, Detail: "The stored idempotent response could not be read.")
                : new(TaskStoreResultKind.Replayed, response);
        }
        catch (JsonException)
        {
            return new(TaskStoreResultKind.Conflict, Detail: "The stored idempotent response could not be read.");
        }
    }

    private static TaskCancelStoreResult ReplayCancel(IdempotencyRecord existing, string requestHash)
    {
        if (!string.Equals(existing.RequestHash, requestHash, StringComparison.Ordinal))
        {
            return new(TaskStoreResultKind.Conflict, Detail: "The Idempotency-Key was already used with a different payload.");
        }

        try
        {
            var response = JsonSerializer.Deserialize<TaskCancelResponse>(existing.ResponseJson, JsonOptions);
            if (response is null)
            {
                return new(TaskStoreResultKind.Conflict, Detail: "The stored idempotent response could not be read.");
            }

            return existing.ResponseStatus == StatusCodes.Conflict
                ? new(TaskStoreResultKind.StateConflict, response, StateConflictDetail)
                : new(TaskStoreResultKind.Replayed, response);
        }
        catch (JsonException)
        {
            return new(TaskStoreResultKind.Conflict, Detail: "The stored idempotent response could not be read.");
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

            if (current is SqliteException sqlite)
            {
                if (sqlite.SqliteErrorCode is 5 or 6)
                {
                    return true;
                }

                if (sqlite.SqliteErrorCode == 19
                    && sqlite.Message.Contains("UNIQUE", StringComparison.OrdinalIgnoreCase))
                {
                    return true;
                }
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

    private static TaskResponse ToResponse(DomainTask task)
    {
        var capabilities = JsonSerializer.Deserialize<string[]>(task.RequiredCapabilitiesJson, JsonOptions)
            ?? Array.Empty<string>();
        var attachmentRefs = JsonSerializer.Deserialize<string[]>(task.AttachmentRefsJson, JsonOptions)
            ?? Array.Empty<string>();
        return new TaskResponse(
            task.Id,
            task.ConversationId,
            task.CreatedByMessageId,
            task.Goal,
            task.ExpectedOutput,
            capabilities,
            attachmentRefs,
            task.PreferredDeviceId,
            task.AssignedDeviceId,
            ToContractWorkerKind(task.WorkerKind),
            ToContractStatus(task.Status),
            task.Priority,
            task.Attempt,
            task.ProgressSummary,
            task.ResultSummary,
            task.ResultPayloadJson,
            task.ErrorCode,
            task.ErrorMessage,
            task.Version,
            task.CreatedAtMs,
            task.StartedAtMs,
            task.CompletedAtMs);
    }

    private static TaskStatusValue ToContractStatus(DomainTaskStatus status) => status switch
    {
        DomainTaskStatus.Queued => TaskStatusValue.Queued,
        DomainTaskStatus.Assigned => TaskStatusValue.Assigned,
        DomainTaskStatus.Running => TaskStatusValue.Running,
        DomainTaskStatus.WaitingForApproval => TaskStatusValue.WaitingForApproval,
        DomainTaskStatus.WaitingForUserInput => TaskStatusValue.WaitingForUserInput,
        DomainTaskStatus.CancellationRequested => TaskStatusValue.CancellationRequested,
        DomainTaskStatus.Recovering => TaskStatusValue.Recovering,
        DomainTaskStatus.Succeeded => TaskStatusValue.Succeeded,
        DomainTaskStatus.Failed => TaskStatusValue.Failed,
        DomainTaskStatus.Cancelled => TaskStatusValue.Cancelled,
        _ => throw new ArgumentOutOfRangeException(nameof(status), status, null)
    };

    private static DomainTaskStatus ToDomainStatus(TaskStatusValue status) => status switch
    {
        TaskStatusValue.Queued => DomainTaskStatus.Queued,
        TaskStatusValue.Assigned => DomainTaskStatus.Assigned,
        TaskStatusValue.Running => DomainTaskStatus.Running,
        TaskStatusValue.WaitingForApproval => DomainTaskStatus.WaitingForApproval,
        TaskStatusValue.WaitingForUserInput => DomainTaskStatus.WaitingForUserInput,
        TaskStatusValue.CancellationRequested => DomainTaskStatus.CancellationRequested,
        TaskStatusValue.Recovering => DomainTaskStatus.Recovering,
        TaskStatusValue.Succeeded => DomainTaskStatus.Succeeded,
        TaskStatusValue.Failed => DomainTaskStatus.Failed,
        TaskStatusValue.Cancelled => DomainTaskStatus.Cancelled,
        _ => throw new ArgumentOutOfRangeException(nameof(status), status, null)
    };

    private static WorkerKindValue ToContractWorkerKind(DomainWorkerKind kind) => kind switch
    {
        DomainWorkerKind.Internal => WorkerKindValue.Internal,
        DomainWorkerKind.Responses => WorkerKindValue.Responses,
        DomainWorkerKind.Codex => WorkerKindValue.Codex,
        _ => throw new ArgumentOutOfRangeException(nameof(kind), kind, null)
    };

    private static class StatusCodes
    {
        public const int Ok = 200;
        public const int Accepted = 202;
        public const int Conflict = 409;
    }
}
