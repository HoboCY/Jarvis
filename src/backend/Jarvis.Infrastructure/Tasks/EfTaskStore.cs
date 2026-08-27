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
using Jarvis.Infrastructure.Observability;
using Microsoft.Data.Sqlite;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Options;
using DomainTask = Jarvis.Domain.Tasks.Task;
using DomainTaskExecution = Jarvis.Domain.Tasks.TaskExecution;
using DomainTaskExecutionStatus = Jarvis.Domain.Tasks.TaskExecutionStatus;
using DomainTaskStatus = Jarvis.Domain.Tasks.TaskStatus;
using DomainTaskEvent = Jarvis.Domain.Tasks.TaskEvent;
using DomainTaskUserInputStatus = Jarvis.Domain.Tasks.TaskUserInputRequestStatus;
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
            sourceMessageIds.Count > 0 ? sourceMessageIds[0] : null,
            capabilityEnvelopeJson: JsonSerializer.Serialize(request.CapabilityEnvelope, JsonOptions));
        db.Tasks.Add(task);

        var accepted = new TaskAcceptedResponse(
            true,
            task.Id,
            ToContractStatus(task.Status),
            ToContractWorkerKind(task.WorkerKind));
        AddTaskEventAndOutbox(task, "task.created", nowMs);
        if (workerKind == DomainWorkerKind.Codex)
        {
            AddOutbox("task.available", new
            {
                userId = task.UserId,
                deviceId = task.PreferredDeviceId,
                taskId = task.Id,
                requiredCapabilities = capabilities,
                occurredAt = nowMs,
                entityVersion = task.Version
            }, nowMs);
        }
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
        if (task is null)
        {
            return null;
        }

        var execution = await db.TaskExecutions.AsNoTracking()
            .Where(item => item.TaskId == taskId)
            .OrderByDescending(item => item.StartedAtMs)
            .FirstOrDefaultAsync(cancellationToken);
        var nowMs = timeProvider.GetUtcNow().ToUnixTimeMilliseconds();
        var pendingUserInput = await db.TaskUserInputRequests.AsNoTracking()
            .Where(item => item.TaskId == taskId
                && task.Status == DomainTaskStatus.WaitingForUserInput
                && (execution == null || item.ExecutionId == execution.Id)
                && item.Status == DomainTaskUserInputStatus.Pending
                && (item.ExpiresAtMs == null || item.ExpiresAtMs > nowMs))
            .OrderByDescending(item => item.CreatedAtMs)
            .Select(item => new PendingUserInputRow(
                item.ExecutionId,
                item.RequestId,
                item.RequestIdIsString,
                item.ItemId,
                item.ThreadId,
                item.TurnId,
                item.QuestionsJson,
                item.ExpiresAtMs))
            .FirstOrDefaultAsync(cancellationToken);
        return ToResponse(task, execution, ToPendingUserInput(pendingUserInput));
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
        var taskIds = tasks.Select(task => task.Id).ToArray();
        var executions = await db.TaskExecutions.AsNoTracking()
            .Where(item => taskIds.Contains(item.TaskId))
            .OrderByDescending(item => item.StartedAtMs)
            .ToListAsync(cancellationToken);
        var latestExecutionByTask = executions
            .GroupBy(item => item.TaskId)
            .ToDictionary(group => group.Key, group => group.First());
        var nowMs = timeProvider.GetUtcNow().ToUnixTimeMilliseconds();
        var pendingUserInputs = await db.TaskUserInputRequests.AsNoTracking()
            .Where(item => taskIds.Contains(item.TaskId)
                && item.Status == DomainTaskUserInputStatus.Pending
                && (item.ExpiresAtMs == null || item.ExpiresAtMs > nowMs))
            .OrderByDescending(item => item.CreatedAtMs)
            .Select(item => new PendingUserInputRow(
                item.TaskId,
                item.ExecutionId,
                item.RequestId,
                item.RequestIdIsString,
                item.ItemId,
                item.ThreadId,
                item.TurnId,
                item.QuestionsJson,
                item.ExpiresAtMs))
            .ToListAsync(cancellationToken);
        var pendingUserInputByTask = tasks.ToDictionary(
            task => task.Id,
            task => task.Status == DomainTaskStatus.WaitingForUserInput
                ? pendingUserInputs.FirstOrDefault(input =>
                    input.TaskId == task.Id
                    && latestExecutionByTask.TryGetValue(task.Id, out var execution)
                    && input.ExecutionId == execution.Id)
                : null);
        return new TaskListResponse(
            tasks.Select(task => ToResponse(
                task,
                latestExecutionByTask.GetValueOrDefault(task.Id),
                ToPendingUserInput(pendingUserInputByTask.GetValueOrDefault(task.Id)))).ToArray(),
            nextCursor);
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

        var wasWaitingForUserInput = task.Status == DomainTaskStatus.WaitingForUserInput;
        var activeExecutionId = wasWaitingForUserInput
            ? await db.TaskExecutions
                .Where(item => item.TaskId == taskId
                    && item.Status != DomainTaskExecutionStatus.Succeeded
                    && item.Status != DomainTaskExecutionStatus.Failed
                    && item.Status != DomainTaskExecutionStatus.Cancelled)
                .OrderByDescending(item => item.StartedAtMs)
                .Select(item => (Guid?)item.Id)
                .FirstOrDefaultAsync(cancellationToken)
            : null;
        var pendingUserInput = wasWaitingForUserInput
            ? await db.TaskUserInputRequests.SingleOrDefaultAsync(
                item => item.TaskId == taskId
                    && item.Status == DomainTaskUserInputStatus.Pending
                    && (activeExecutionId == null || item.ExecutionId == activeExecutionId),
                cancellationToken)
            : null;

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
            if (wasWaitingForUserInput && pendingUserInput is not null && pendingUserInput.Clear(nowMs))
            {
                MarkUserInputNotificationActioned(task, pendingUserInput.RequestId, nowMs);
                AddTaskEventAndOutbox(task, "task.userInputCancelled", nowMs);
                AddOutbox("task.userInputCancelled", new
                {
                    userId = task.UserId,
                    deviceId = task.AssignedDeviceId,
                    taskId = task.Id,
                    requestId = pendingUserInput.RequestId,
                    occurredAt = nowMs,
                    entityVersion = task.Version
                }, nowMs);
            }

            AddTaskEventAndOutbox(task, "task.cancellationRequested", nowMs);
            if (task.Status == DomainTaskStatus.CancellationRequested
                && task.AssignedDeviceId is Guid assignedDeviceId)
            {
                AddOutbox("task.cancellationRequested", new
                {
                    userId = task.UserId,
                    deviceId = assignedDeviceId,
                    conversationId = task.ConversationId,
                    taskId = task.Id,
                    status = "cancellationRequested",
                    occurredAt = nowMs,
                    entityVersion = task.Version
                }, nowMs);
            }
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
            actionsJson = notification.ActionsJson,
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
            deviceId = task.AssignedDeviceId,
            conversationId = task.ConversationId,
            taskId = task.Id,
            status = JsonNamingPolicy.CamelCase.ConvertName(task.Status.ToString()),
            eventType,
            pendingUserInput = (object?)null,
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

    public void FailClosedUserInput(
        DomainTask task,
        DomainTaskExecution execution,
        string errorCode,
        string errorMessage,
        long nowMs)
    {
        if (task.Status is DomainTaskStatus.WaitingForUserInput or DomainTaskStatus.Recovering)
        {
            task.MarkFailed(errorCode, errorMessage, nowMs);
        }

        if (execution.Status is DomainTaskExecutionStatus.WaitingForUserInput or DomainTaskExecutionStatus.Recovering)
        {
            execution.MarkFailed(JsonSerializer.Serialize(new { reason = errorCode }, JsonOptions), nowMs);
        }

        AddTerminalNotification(
            task,
            "task.failed",
            NotificationSeverity.Error,
            "后台任务无法继续",
            errorMessage,
            nowMs);
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

    public void MarkUserInputNotificationActioned(
        DomainTask task,
        string requestId,
        long nowMs,
        string action = "userInputCancelled")
    {
        var notification = db.Notifications.SingleOrDefault(item =>
            item.UserId == task.UserId
            && item.TaskId == task.Id
            && item.Type == "task.needsUserInput"
            && item.DedupKey == $"task:{task.Id:D}:user-input:{requestId}");
        if (notification is null || notification.Status is NotificationStatus.Actioned or NotificationStatus.Dismissed)
        {
            return;
        }

        if (!notification.MarkActioned(nowMs))
        {
            return;
        }

        AddOutbox("notification.updated", new
        {
            userId = task.UserId,
            notificationId = notification.Id,
            taskId = notification.TaskId,
            conversationId = notification.ConversationId,
            status = "actioned",
            title = notification.Title,
            body = notification.Body,
            type = notification.Type,
            dedupKey = notification.DedupKey,
            action,
            entityVersion = notification.Version
        }, nowMs);
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

    private static TaskResponse ToResponse(
        DomainTask task,
        DomainTaskExecution? execution = null,
        TaskUserInputResponse? pendingUserInput = null)
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
            task.CompletedAtMs,
            execution is null ? null : ToExecutionResponse(execution),
            execution is null ? Array.Empty<ArtifactManifestEntry>() : DeserializeArtifacts(execution.ArtifactManifestJson),
            DeserializeCapabilityEnvelope(task.CapabilityEnvelopeJson),
            pendingUserInput);
    }

    private static TaskExecutionResponse ToExecutionResponse(DomainTaskExecution execution) => new(
        execution.Id,
        execution.TaskId,
        execution.DeviceId,
        ToContractWorkerKind(execution.WorkerKind),
        execution.ExternalExecutionId,
        execution.CodexThreadId,
        execution.CodexTurnId,
        (TaskExecutionStatusValue)execution.Status,
        execution.MetadataJson,
        execution.ResultPayloadJson,
        DeserializeArtifacts(execution.ArtifactManifestJson),
        execution.StartedAtMs,
        execution.EndedAtMs,
        execution.Version,
        execution.CodexTurnStartRequestedAtMs);

    private static ArtifactManifestEntry[] DeserializeArtifacts(string json)
    {
        try
        {
            return JsonSerializer.Deserialize<ArtifactManifestEntry[]>(json, JsonOptions) ?? Array.Empty<ArtifactManifestEntry>();
        }
        catch (JsonException)
        {
            return Array.Empty<ArtifactManifestEntry>();
        }
    }

    private static CapabilityEnvelopeContract? DeserializeCapabilityEnvelope(string json)
    {
        try
        {
            return JsonSerializer.Deserialize<CapabilityEnvelopeContract>(json, JsonOptions);
        }
        catch (JsonException)
        {
            return null;
        }
    }

    private static TaskUserInputResponse? ToPendingUserInput(PendingUserInputRow? value)
    {
        if (value is null)
        {
            return null;
        }

        try
        {
            var questions = JsonSerializer.Deserialize<TaskUserInputQuestion[]>(value.QuestionsJson, JsonOptions);
            return questions is null
                ? null
                : new TaskUserInputResponse(
                    value.RequestId,
                    value.ItemId,
                    value.ThreadId,
                    value.TurnId,
                    questions,
                    TaskUserInputStatusValue.Pending,
                    value.ExpiresAtMs,
                    value.RequestIdIsString);
        }
        catch (JsonException)
        {
            return null;
        }
    }

    private sealed record PendingUserInputRow(
        Guid ExecutionId,
        string RequestId,
        bool RequestIdIsString,
        string ItemId,
        string ThreadId,
        string TurnId,
        string QuestionsJson,
        long? ExpiresAtMs)
    {
        public PendingUserInputRow(
            Guid taskId,
            Guid executionId,
            string requestId,
            bool requestIdIsString,
            string itemId,
            string threadId,
            string turnId,
            string questionsJson,
            long? expiresAtMs)
            : this(executionId, requestId, requestIdIsString, itemId, threadId, turnId, questionsJson, expiresAtMs) => TaskId = taskId;

        public Guid TaskId { get; }
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
