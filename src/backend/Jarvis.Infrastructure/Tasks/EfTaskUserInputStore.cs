using System.Data;
using System.Data.Common;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Jarvis.Application.Tasks;
using Jarvis.Contracts;
using Jarvis.Domain.Devices;
using Jarvis.Domain.Idempotency;
using Jarvis.Domain.Notifications;
using Jarvis.Domain.Outbox;
using Jarvis.Domain.Tasks;
using Jarvis.Infrastructure.Data;
using Jarvis.Infrastructure.Idempotency;
using Jarvis.Infrastructure.Observability;
using Microsoft.Data.Sqlite;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Options;
using DomainTask = Jarvis.Domain.Tasks.Task;
using DomainTaskExecution = Jarvis.Domain.Tasks.TaskExecution;
using DomainTaskStatus = Jarvis.Domain.Tasks.TaskStatus;

namespace Jarvis.Infrastructure.Tasks;

/// <summary>
/// Persists Codex user-input requests and all state transitions in the same database
/// transaction as the task, execution, audit event, notification, and outbox hints.
/// </summary>
public sealed class EfTaskUserInputStore(
    JarvisDbContext db,
    TimeProvider timeProvider,
    IOptions<IdempotencyOptions> idempotencyOptions,
    EfTaskStore taskStore) : ITaskUserInputStore
{
    private static readonly JsonSerializerOptions JsonOptions = new(JsonSerializerDefaults.Web);
    private const int MaxWriteAttempts = 5;

    public async Task<TaskUserInputOperation<DeviceTaskUserInputResponse>> CreateDeviceRequestAsync(
        Guid deviceId,
        Guid taskId,
        DeviceTaskUserInputRequest request,
        string leaseOwner,
        string idempotencyKey,
        CancellationToken cancellationToken)
    {
        for (var attempt = 1; ; attempt++)
        {
            try
            {
                return await CreateDeviceRequestOnceAsync(
                    deviceId,
                    taskId,
                    request,
                    leaseOwner,
                    idempotencyKey,
                    cancellationToken).ConfigureAwait(false);
            }
            catch (Exception exception) when (attempt < MaxWriteAttempts && IsRecognizedWriteRace(exception))
            {
                db.ChangeTracker.Clear();
                var userId = await GetUserIdForDeviceAsync(deviceId, cancellationToken).ConfigureAwait(false);
                IdempotencyRecord? existing;
                try
                {
                    existing = await FindIdempotencyAsync(
                        userId,
                        $"devices:{deviceId:D}:tasks:{taskId:D}:user-input",
                        idempotencyKey,
                        cancellationToken).ConfigureAwait(false);
                }
                catch (Exception lookupException) when (IsRecognizedWriteRace(lookupException))
                {
                    existing = null;
                }
                if (existing is not null)
                {
                    return Replay(existing, Hash(request));
                }

                await System.Threading.Tasks.Task.Delay(TimeSpan.FromMilliseconds(10L * attempt), cancellationToken).ConfigureAwait(false);
            }
        }
    }

    private async Task<TaskUserInputOperation<DeviceTaskUserInputResponse>> CreateDeviceRequestOnceAsync(
        Guid deviceId,
        Guid taskId,
        DeviceTaskUserInputRequest request,
        string leaseOwner,
        string idempotencyKey,
        CancellationToken cancellationToken)
    {
        if (deviceId == Guid.Empty || taskId == Guid.Empty || string.IsNullOrWhiteSpace(leaseOwner))
        {
            return Invalid<DeviceTaskUserInputResponse>("The device task user-input request is invalid.");
        }

        var nowMs = Now();
        if (!TaskUserInputValidation.TryValidateRequest(request, nowMs, out var validationError))
        {
            return Invalid<DeviceTaskUserInputResponse>(validationError);
        }

        var requestHash = Hash(request);
        var scope = $"devices:{deviceId:D}:tasks:{taskId:D}:user-input";
        var userId = await GetUserIdForDeviceAsync(deviceId, cancellationToken);
        var existingIdempotency = await FindIdempotencyAsync(userId, scope, idempotencyKey, cancellationToken);
        if (existingIdempotency is not null)
        {
            return Replay(existingIdempotency, requestHash);
        }

        await using var transaction = await db.Database.BeginTransactionAsync(IsolationLevel.Serializable, cancellationToken);
        nowMs = Now();
        await DeleteExpiredIdempotencyAsync(userId, scope, idempotencyKey, nowMs, cancellationToken).ConfigureAwait(false);
        var device = await db.Devices.AsNoTracking().SingleOrDefaultAsync(item => item.Id == deviceId, cancellationToken);
        if (device is null || device.Status == DeviceStatus.Disabled)
        {
            return new(TaskUserInputOperationStatus.Unauthorized, Detail: "The device is not enabled.");
        }

        var task = await db.Tasks.SingleOrDefaultAsync(item => item.Id == taskId && item.AssignedDeviceId == deviceId, cancellationToken);
        var execution = await db.TaskExecutions.SingleOrDefaultAsync(
            item => item.Id == request.ExecutionId && item.TaskId == taskId && item.DeviceId == deviceId,
            cancellationToken);
        if (task is null || execution is null)
        {
            return new(TaskUserInputOperationStatus.NotFound, Detail: "The task execution is not owned by this device.");
        }

        var existingRequest = await db.TaskUserInputRequests.SingleOrDefaultAsync(
            item => item.DeviceId == deviceId
                && item.ExecutionId == request.ExecutionId
                && item.RequestId == request.RequestId
                && item.RequestIdIsString == request.RequestIdIsString,
            cancellationToken);
        if (existingRequest is not null)
        {
            if (!Matches(existingRequest, request))
            {
                return new(TaskUserInputOperationStatus.Conflict, Detail: "RequestId was already used with a different user-input request.");
            }

            var replay = ToDeviceResponse(existingRequest, includeAnswers: true);
            AddIdempotency(device.UserId, scope, idempotencyKey, requestHash, 200, ToDeviceResponse(existingRequest, includeAnswers: false), nowMs);
            await db.SaveChangesAsync(cancellationToken);
            await transaction.CommitAsync(cancellationToken);
            return new(TaskUserInputOperationStatus.Replayed, replay);
        }

        if (task.Status != DomainTaskStatus.Running
            || execution.Status != TaskExecutionStatus.Running
            || !string.Equals(task.LeaseOwner, leaseOwner.Trim(), StringComparison.Ordinal)
            || task.LeaseExpiresAtMs is not long leaseExpiresAtMs
            || leaseExpiresAtMs <= nowMs
            || !string.Equals(execution.CodexThreadId, request.ThreadId, StringComparison.Ordinal)
            || !string.Equals(execution.CodexTurnId, request.TurnId, StringComparison.Ordinal))
        {
            return new(TaskUserInputOperationStatus.StateConflict, Detail: "The task execution is not active for this device.");
        }

        var expiresAtMs = TaskUserInputValidation.GetExpiry(nowMs, request.AutoResolutionMs);
        if (expiresAtMs is long expiryAtMs && (expiryAtMs <= 0 || expiryAtMs <= nowMs))
        {
            return new(TaskUserInputOperationStatus.StateConflict, Detail: "The Codex user-input request has already expired.");
        }

        var userInput = TaskUserInputRequest.Create(
            Guid.CreateVersion7(),
            task.Id,
            execution.Id,
            deviceId,
            request.RequestId,
            request.RequestIdIsString,
            request.ItemId,
            request.ThreadId,
            request.TurnId,
            JsonSerializer.Serialize(request.Questions, JsonOptions),
            nowMs,
            expiresAtMs);
        task.WaitForUserInput(nowMs);
        execution.WaitForUserInput(nowMs);
        db.TaskUserInputRequests.Add(userInput);
        AddTaskEvent(task, execution, deviceId, "task.userInputRequired", new
        {
            requestId = userInput.RequestId,
            itemId = userInput.ItemId,
            questionCount = request.Questions.Count
        }, nowMs, ToTaskResponse(userInput));
        AddNeedsInputNotification(task, userInput.RequestId, nowMs);
        AddOutbox("task.userInputRequired", new
        {
            userId = task.UserId,
            deviceId,
            taskId,
            executionId = execution.Id,
            requestId = userInput.RequestId,
            questionCount = request.Questions.Count,
            pendingUserInput = ToTaskResponse(userInput),
            occurredAt = nowMs,
            entityVersion = task.Version
        }, nowMs);
        var response = ToDeviceResponse(userInput, includeAnswers: false);
        AddIdempotency(device.UserId, scope, idempotencyKey, requestHash, 201, response, nowMs);
        await db.SaveChangesAsync(cancellationToken);
        await transaction.CommitAsync(cancellationToken);
        return new(TaskUserInputOperationStatus.Succeeded, response);
    }

    public async Task<TaskUserInputOperation<DeviceTaskUserInputResponse>> GetDeviceRequestAsync(
        Guid deviceId,
        Guid taskId,
        Guid executionId,
        string requestId,
        bool requestIdIsString,
        string leaseOwner,
        CancellationToken cancellationToken)
    {
        var request = await db.TaskUserInputRequests.AsNoTracking().SingleOrDefaultAsync(
            item => item.DeviceId == deviceId
                && item.TaskId == taskId
                && item.ExecutionId == executionId
                && item.RequestId == requestId
                && item.RequestIdIsString == requestIdIsString,
            cancellationToken);
        if (request is null)
        {
            return new(TaskUserInputOperationStatus.NotFound, Detail: "The user-input request was not found for this device.");
        }

        if (request.Status is TaskUserInputRequestStatus.Pending or TaskUserInputRequestStatus.Answered)
        {
            var activeTask = await db.Tasks.AsNoTracking().SingleOrDefaultAsync(
                item => item.Id == taskId && item.AssignedDeviceId == deviceId,
                cancellationToken);
            var activeExecution = await db.TaskExecutions.AsNoTracking().SingleOrDefaultAsync(
                item => item.Id == executionId && item.TaskId == taskId && item.DeviceId == deviceId,
                cancellationToken);
            if (activeTask is null
                || activeExecution is null
                || !string.Equals(activeTask.LeaseOwner, leaseOwner.Trim(), StringComparison.Ordinal)
                || activeTask.LeaseExpiresAtMs is not long leaseExpiresAtMs
                || leaseExpiresAtMs <= Now()
                || (request.Status == TaskUserInputRequestStatus.Pending
                    && (activeTask.Status != DomainTaskStatus.WaitingForUserInput
                        || activeExecution.Status != TaskExecutionStatus.WaitingForUserInput)))
            {
                return new(TaskUserInputOperationStatus.StateConflict, Detail: "The task execution is not active for this device.");
            }
        }

        if (request.Status != TaskUserInputRequestStatus.Pending
            || request.ExpiresAtMs is not long expiresAtMs
            || expiresAtMs > Now())
        {
            return new(TaskUserInputOperationStatus.Succeeded, ToDeviceResponse(request, includeAnswers: true));
        }

        await using var transaction = await db.Database.BeginTransactionAsync(IsolationLevel.Serializable, cancellationToken);
        var nowMs = Now();
        var trackedRequest = await db.TaskUserInputRequests.SingleOrDefaultAsync(
            item => item.DeviceId == deviceId
                && item.TaskId == taskId
                && item.ExecutionId == executionId
                && item.RequestId == requestId
                && item.RequestIdIsString == requestIdIsString,
            cancellationToken);
        if (trackedRequest is null)
        {
            return new(TaskUserInputOperationStatus.NotFound, Detail: "The user-input request was not found for this device.");
        }

        if (trackedRequest.Status == TaskUserInputRequestStatus.Pending
            && trackedRequest.ExpiresAtMs is long trackedExpiresAtMs
            && trackedExpiresAtMs <= nowMs)
        {
            var task = await db.Tasks.SingleOrDefaultAsync(
                item => item.Id == taskId && item.AssignedDeviceId == deviceId,
                cancellationToken);
            var execution = await db.TaskExecutions.SingleOrDefaultAsync(
                item => item.Id == trackedRequest.ExecutionId && item.TaskId == taskId && item.DeviceId == deviceId,
                cancellationToken);
            if (trackedRequest.Expire(nowMs))
            {
                if (task is not null && execution is not null)
                {
                    taskStore.FailClosedUserInput(task, execution, "codex_user_input_expired", "The Codex user-input request expired before it was answered.", nowMs);
                    taskStore.MarkUserInputNotificationActioned(task, trackedRequest.RequestId, nowMs, "userInputExpired");
                    AddTaskEvent(task, execution, deviceId, "task.userInputExpired", new { requestId = trackedRequest.RequestId }, nowMs, null);
                    AddOutbox("task.userInputExpired", new
                    {
                        userId = task.UserId,
                        deviceId,
                        taskId,
                        executionId = execution.Id,
                        requestId = trackedRequest.RequestId,
                        occurredAt = nowMs,
                        entityVersion = task.Version
                    }, nowMs);
                }

                await db.SaveChangesAsync(cancellationToken);
            }
        }

        await transaction.CommitAsync(cancellationToken);
        return new(TaskUserInputOperationStatus.Succeeded, ToDeviceResponse(trackedRequest, includeAnswers: true));
    }

    public async Task<TaskUserInputOperation<DeviceTaskUserInputResponse>> ResolveDeviceRequestAsync(
        Guid deviceId,
        Guid taskId,
        Guid executionId,
        string requestId,
        bool requestIdIsString,
        string leaseOwner,
        string idempotencyKey,
        CancellationToken cancellationToken)
    {
        for (var attempt = 1; ; attempt++)
        {
            try
            {
                return await ResolveDeviceRequestOnceAsync(
                    deviceId,
                    taskId,
                    executionId,
                    requestId,
                    requestIdIsString,
                    leaseOwner,
                    idempotencyKey,
                    cancellationToken).ConfigureAwait(false);
            }
            catch (Exception exception) when (attempt < MaxWriteAttempts && IsRecognizedWriteRace(exception))
            {
                db.ChangeTracker.Clear();
                var userId = await GetUserIdForDeviceAsync(deviceId, cancellationToken).ConfigureAwait(false);
                IdempotencyRecord? existing;
                try
                {
                    existing = await FindIdempotencyAsync(
                        userId,
                        $"devices:{deviceId:D}:tasks:{taskId:D}:user-input-resolve",
                        idempotencyKey,
                        cancellationToken).ConfigureAwait(false);
                }
                catch (Exception lookupException) when (IsRecognizedWriteRace(lookupException))
                {
                    existing = null;
                }
                if (existing is not null)
                {
                    return Replay(existing, Hash(new { taskId, executionId, requestId, requestIdIsString }));
                }

                await System.Threading.Tasks.Task.Delay(TimeSpan.FromMilliseconds(10L * attempt), cancellationToken).ConfigureAwait(false);
            }
        }
    }

    private async Task<TaskUserInputOperation<DeviceTaskUserInputResponse>> ResolveDeviceRequestOnceAsync(
        Guid deviceId,
        Guid taskId,
        Guid executionId,
        string requestId,
        bool requestIdIsString,
        string leaseOwner,
        string idempotencyKey,
        CancellationToken cancellationToken)
    {
        if (deviceId == Guid.Empty || taskId == Guid.Empty || executionId == Guid.Empty || string.IsNullOrWhiteSpace(requestId)
            || string.IsNullOrWhiteSpace(leaseOwner) || string.IsNullOrWhiteSpace(idempotencyKey))
        {
            return Invalid<DeviceTaskUserInputResponse>("The user-input resolution request is invalid.");
        }

        var userId = await GetUserIdForDeviceAsync(deviceId, cancellationToken);
        if (userId == Guid.Empty)
        {
            return new(TaskUserInputOperationStatus.Unauthorized, Detail: "The device is not enabled.");
        }

        var emptyHash = Hash(new { taskId, executionId, requestId, requestIdIsString });
        var scope = $"devices:{deviceId:D}:tasks:{taskId:D}:user-input-resolve";
        var existingIdempotency = await FindIdempotencyAsync(userId, scope, idempotencyKey, cancellationToken);
        if (existingIdempotency is not null)
        {
            return Replay(existingIdempotency, emptyHash);
        }

        await using var transaction = await db.Database.BeginTransactionAsync(IsolationLevel.Serializable, cancellationToken);
        var nowMs = Now();
        await DeleteExpiredIdempotencyAsync(userId, scope, idempotencyKey, nowMs, cancellationToken).ConfigureAwait(false);
        var request = await db.TaskUserInputRequests.SingleOrDefaultAsync(
            item => item.DeviceId == deviceId
                && item.TaskId == taskId
                && item.ExecutionId == executionId
                && item.RequestId == requestId
                && item.RequestIdIsString == requestIdIsString,
            cancellationToken);
        var task = await db.Tasks.SingleOrDefaultAsync(item => item.Id == taskId && item.AssignedDeviceId == deviceId, cancellationToken);
        var execution = request is null
            ? null
            : await db.TaskExecutions.SingleOrDefaultAsync(item => item.Id == request.ExecutionId && item.TaskId == taskId && item.DeviceId == deviceId, cancellationToken);
        if (request is null || task is null || execution is null)
        {
            return new(TaskUserInputOperationStatus.NotFound, Detail: "The user-input request was not found for this device.");
        }

        if (request.Status == TaskUserInputRequestStatus.Pending)
        {
            if (!string.Equals(task.LeaseOwner, leaseOwner.Trim(), StringComparison.Ordinal)
                || task.LeaseExpiresAtMs is not long leaseExpiresAtMs
                || leaseExpiresAtMs <= nowMs)
            {
                return new(TaskUserInputOperationStatus.StateConflict, Detail: "The task lease is not owned by this device.");
            }

            if (!request.Clear(nowMs))
            {
                return new(TaskUserInputOperationStatus.StateConflict, Detail: "The user-input request is no longer pending.");
            }

            taskStore.FailClosedUserInput(task, execution, "codex_user_input_resolved", "Codex cleared the user-input request before it was answered.", nowMs);
            taskStore.MarkUserInputNotificationActioned(task, request.RequestId, nowMs, "userInputResolved");
            AddTaskEvent(task, execution, deviceId, "task.userInputCleared", new { requestId = request.RequestId }, nowMs, null);
            AddOutbox("task.userInputCleared", new
            {
                userId,
                deviceId,
                taskId,
                executionId = execution.Id,
                requestId,
                occurredAt = nowMs,
                entityVersion = task.Version
            }, nowMs);
        }

        var response = ToDeviceResponse(request, includeAnswers: false);
        AddIdempotency(userId, scope, idempotencyKey, emptyHash, 200, response, nowMs);
        await db.SaveChangesAsync(cancellationToken);
        await transaction.CommitAsync(cancellationToken);
        return new(TaskUserInputOperationStatus.Succeeded, response);
    }

    public async Task<TaskUserInputOperation<TaskUserInputSubmissionResponse>> SubmitAsync(
        Guid userId,
        Guid taskId,
        TaskUserInputSubmissionRequest request,
        string idempotencyKey,
        CancellationToken cancellationToken)
    {
        for (var attempt = 1; ; attempt++)
        {
            try
            {
                return await SubmitOnceAsync(
                    userId,
                    taskId,
                    request,
                    idempotencyKey,
                    cancellationToken).ConfigureAwait(false);
            }
            catch (Exception exception) when (attempt < MaxWriteAttempts && IsRecognizedWriteRace(exception))
            {
                db.ChangeTracker.Clear();
                IdempotencyRecord? existing;
                try
                {
                    existing = await FindIdempotencyAsync(
                        userId,
                        $"tasks:{taskId:D}:user-input",
                        idempotencyKey,
                        cancellationToken).ConfigureAwait(false);
                }
                catch (Exception lookupException) when (IsRecognizedWriteRace(lookupException))
                {
                    existing = null;
                }
                if (existing is not null)
                {
                    return ReplaySubmission(existing, Hash(request));
                }

                await System.Threading.Tasks.Task.Delay(TimeSpan.FromMilliseconds(10L * attempt), cancellationToken).ConfigureAwait(false);
            }
        }
    }

    private async Task<TaskUserInputOperation<TaskUserInputSubmissionResponse>> SubmitOnceAsync(
        Guid userId,
        Guid taskId,
        TaskUserInputSubmissionRequest request,
        string idempotencyKey,
        CancellationToken cancellationToken)
    {
        if (userId == Guid.Empty || taskId == Guid.Empty || string.IsNullOrWhiteSpace(idempotencyKey))
        {
            return Invalid<TaskUserInputSubmissionResponse>("The user-input submission is invalid.");
        }

        var requestHash = Hash(request);
        var scope = $"tasks:{taskId:D}:user-input";
        var existingIdempotency = await FindIdempotencyAsync(userId, scope, idempotencyKey, cancellationToken);
        if (existingIdempotency is not null)
        {
            return ReplaySubmission(existingIdempotency, requestHash);
        }

        await using var transaction = await db.Database.BeginTransactionAsync(IsolationLevel.Serializable, cancellationToken);
        var nowMs = Now();
        await DeleteExpiredIdempotencyAsync(userId, scope, idempotencyKey, nowMs, cancellationToken).ConfigureAwait(false);
        var existingIdempotencyInTransaction = await FindIdempotencyAsync(userId, scope, idempotencyKey, cancellationToken);
        if (existingIdempotencyInTransaction is not null)
        {
            return ReplaySubmission(existingIdempotencyInTransaction, requestHash);
        }
        var task = await db.Tasks.SingleOrDefaultAsync(item => item.Id == taskId && item.UserId == userId, cancellationToken);
        if (task is null)
        {
            return new(TaskUserInputOperationStatus.NotFound, Detail: "The task does not exist or is not owned by this user.");
        }

        var pendingCandidates = await db.TaskUserInputRequests
            .Where(item => item.TaskId == taskId
                && item.RequestId == request.RequestId
                && item.RequestIdIsString == request.RequestIdIsString
                && (request.ExecutionId == null || item.ExecutionId == request.ExecutionId))
            .OrderByDescending(item => item.CreatedAtMs)
            .Take(2)
            .ToListAsync(cancellationToken);
        var pending = pendingCandidates.Count == 1 ? pendingCandidates[0] : null;
        if (pendingCandidates.Count > 1)
        {
            return new(TaskUserInputOperationStatus.Conflict, Detail: "The user-input request identity is ambiguous.");
        }
        var execution = pending is null
            ? null
            : await db.TaskExecutions.SingleOrDefaultAsync(item => item.Id == pending.ExecutionId && item.TaskId == taskId, cancellationToken);
        if (pending is null || execution is null)
        {
            return new(TaskUserInputOperationStatus.NotFound, Detail: "The user-input request was not found.");
        }

        var questions = DeserializeQuestions(pending.QuestionsJson);
        if (!TaskUserInputValidation.TryValidateSubmission(request, questions, out var validationError))
        {
            return Invalid<TaskUserInputSubmissionResponse>(validationError);
        }

        if (pending.Status != TaskUserInputRequestStatus.Pending
            || task.Status != DomainTaskStatus.WaitingForUserInput
            || execution.Status != TaskExecutionStatus.WaitingForUserInput)
        {
            return new(TaskUserInputOperationStatus.StateConflict, Detail: "The user-input request is no longer pending.");
        }

        if (pending.ExpiresAtMs is long expiresAtMs && expiresAtMs <= nowMs)
        {
            pending.Expire(nowMs);
            taskStore.FailClosedUserInput(task, execution, "codex_user_input_expired", "The Codex user-input request expired before it was answered.", nowMs);
            taskStore.MarkUserInputNotificationActioned(task, pending.RequestId, nowMs, "userInputExpired");
            AddTaskEvent(task, execution, pending.DeviceId, "task.userInputExpired", new { requestId = pending.RequestId }, nowMs, null);
            AddOutbox("task.userInputExpired", new
            {
                userId,
                deviceId = pending.DeviceId,
                taskId,
                executionId = execution.Id,
                requestId = pending.RequestId,
                occurredAt = nowMs,
                entityVersion = task.Version
            }, nowMs);
            var expired = new TaskUserInputSubmissionResponse(task.Id, execution.Id, pending.RequestId, false, ToTaskStatus(task.Status), ToExecutionStatus(execution.Status));
            AddIdempotency(userId, scope, idempotencyKey, requestHash, 409, expired, nowMs);
            await db.SaveChangesAsync(cancellationToken);
            await transaction.CommitAsync(cancellationToken);
            return new(TaskUserInputOperationStatus.StateConflict, expired, "The user-input request expired before it was answered.");
        }

        var answersJson = JsonSerializer.Serialize(request.Answers, JsonOptions);
        if (!pending.Answer(answersJson, nowMs))
        {
            return new(TaskUserInputOperationStatus.StateConflict, Detail: "The user-input request is no longer pending.");
        }

        task.Resume(nowMs);
        execution.Resume(nowMs);
        taskStore.MarkUserInputNotificationActioned(task, pending.RequestId, nowMs, "userInput");
        var answerCount = request.Answers.Sum(pair => pair.Value.Answers.Count);
        AddTaskEvent(task, execution, pending.DeviceId, "task.userInputAnswered", new
        {
            requestId = pending.RequestId,
            answerCount
        }, nowMs, null);
        AddOutbox("task.userInputAnswered", new
        {
            userId,
            deviceId = pending.DeviceId,
            taskId,
            executionId = execution.Id,
            requestId = pending.RequestId,
            answerCount,
            occurredAt = nowMs,
            entityVersion = task.Version
        }, nowMs);
        var response = new TaskUserInputSubmissionResponse(task.Id, execution.Id, pending.RequestId, true, ToTaskStatus(task.Status), ToExecutionStatus(execution.Status));
        AddIdempotency(userId, scope, idempotencyKey, requestHash, 200, response, nowMs);
        await db.SaveChangesAsync(cancellationToken);
        await transaction.CommitAsync(cancellationToken);
        return new(TaskUserInputOperationStatus.Succeeded, response);
    }

    public async Task<TaskUserInputResponse?> GetPendingAsync(Guid taskId, CancellationToken cancellationToken)
    {
        var nowMs = Now();
        var pending = await db.TaskUserInputRequests.AsNoTracking()
            .Where(item => item.TaskId == taskId
                && item.Status == TaskUserInputRequestStatus.Pending
                && (item.ExpiresAtMs == null || item.ExpiresAtMs > nowMs))
            .OrderByDescending(item => item.CreatedAtMs)
            .FirstOrDefaultAsync(cancellationToken);
        return pending is null ? null : ToTaskResponse(pending);
    }

    private async Task<Guid> GetUserIdForDeviceAsync(Guid deviceId, CancellationToken cancellationToken) =>
        await db.Devices.AsNoTracking()
            .Where(item => item.Id == deviceId && item.Status != DeviceStatus.Disabled)
            .Select(item => (Guid?)item.UserId)
            .SingleOrDefaultAsync(cancellationToken) ?? Guid.Empty;

    private async Task<IdempotencyRecord?> FindIdempotencyAsync(Guid userId, string scope, string key, CancellationToken cancellationToken)
    {
        if (userId == Guid.Empty)
        {
            return null;
        }

        var nowMs = Now();
        return await db.IdempotencyRecords.AsNoTracking().SingleOrDefaultAsync(
            item => item.UserId == userId && item.Scope == scope && item.IdempotencyKey == key && item.ExpiresAtMs > nowMs,
            cancellationToken);
    }

    private Task<int> DeleteExpiredIdempotencyAsync(
        Guid userId,
        string scope,
        string key,
        long nowMs,
        CancellationToken cancellationToken) =>
        db.IdempotencyRecords
            .Where(item => item.UserId == userId
                && item.Scope == scope
                && item.IdempotencyKey == key
                && item.ExpiresAtMs <= nowMs)
            .ExecuteDeleteAsync(cancellationToken);

    private void AddIdempotency<T>(Guid userId, string scope, string key, string requestHash, int responseStatus, T response, long nowMs) =>
        db.IdempotencyRecords.Add(IdempotencyRecord.Create(
            userId,
            scope,
            key,
            requestHash,
            responseStatus,
            JsonSerializer.Serialize(response, JsonOptions),
            nowMs,
            checked(nowMs + idempotencyOptions.Value.RetentionMs)));

    private static TaskUserInputOperation<DeviceTaskUserInputResponse> Replay(
        IdempotencyRecord existing,
        string requestHash)
    {
        if (!string.Equals(existing.RequestHash, requestHash, StringComparison.Ordinal))
        {
            return new(TaskUserInputOperationStatus.Conflict, Detail: "The Idempotency-Key was already used with a different payload.");
        }

        var response = JsonSerializer.Deserialize<DeviceTaskUserInputResponse>(existing.ResponseJson, JsonOptions);
        return response is null
            ? new(TaskUserInputOperationStatus.Conflict, Detail: "The stored response could not be read.")
            : new(TaskUserInputOperationStatus.Replayed, response);
    }

    private static TaskUserInputOperation<TaskUserInputSubmissionResponse> ReplaySubmission(IdempotencyRecord existing, string requestHash)
    {
        if (!string.Equals(existing.RequestHash, requestHash, StringComparison.Ordinal))
        {
            return new(TaskUserInputOperationStatus.Conflict, Detail: "The Idempotency-Key was already used with a different payload.");
        }

        var response = JsonSerializer.Deserialize<TaskUserInputSubmissionResponse>(existing.ResponseJson, JsonOptions);
        return response is null
            ? new(TaskUserInputOperationStatus.Conflict, Detail: "The stored response could not be read.")
            : existing.ResponseStatus == 409
                ? new(TaskUserInputOperationStatus.StateConflict, response, "The user-input request is no longer pending.")
                : new(TaskUserInputOperationStatus.Replayed, response);
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

    private static bool Matches(TaskUserInputRequest existing, DeviceTaskUserInputRequest request) =>
        existing.ExecutionId == request.ExecutionId
        && existing.RequestIdIsString == request.RequestIdIsString
        && string.Equals(existing.ItemId, request.ItemId, StringComparison.Ordinal)
        && string.Equals(existing.ThreadId, request.ThreadId, StringComparison.Ordinal)
        && string.Equals(existing.TurnId, request.TurnId, StringComparison.Ordinal)
        && string.Equals(existing.QuestionsJson, JsonSerializer.Serialize(request.Questions, JsonOptions), StringComparison.Ordinal);

    private void AddNeedsInputNotification(DomainTask task, string requestId, long nowMs)
    {
        var dedupKey = $"task:{task.Id:D}:user-input:{requestId}";
        if (db.Notifications.Any(item => item.UserId == task.UserId && item.DedupKey == dedupKey))
        {
            return;
        }

        var notification = Notification.Create(
            Guid.CreateVersion7(),
            task.UserId,
            task.ConversationId,
            task.Id,
            "task.needsUserInput",
            NotificationSeverity.Info,
            "后台任务需要输入",
            "Codex is waiting for your answers before it can continue.",
            dedupKey,
            nowMs);
        db.Notifications.Add(notification);
        AddOutbox("notification.created", new
        {
            userId = task.UserId,
            notificationId = notification.Id,
            taskId = task.Id,
            conversationId = task.ConversationId,
            type = "task.needsUserInput",
            severity = "info",
            title = notification.Title,
            body = notification.Body,
            status = "pending",
            actionsJson = notification.ActionsJson,
            dedupKey,
            entityVersion = notification.Version
        }, nowMs);
    }

    private void AddTaskEvent(
        DomainTask task,
        DomainTaskExecution execution,
        Guid deviceId,
        string eventType,
        object safePayload,
        long nowMs,
        TaskUserInputResponse? pendingUserInput)
    {
        var sequence = (db.TaskEvents.Where(item => item.TaskId == task.Id).Select(item => (long?)item.Sequence).Max() ?? 0L)
            + db.ChangeTracker.Entries<TaskEvent>().Count(item => item.State == EntityState.Added && item.Entity.TaskId == task.Id)
            + 1L;
        var payload = new
        {
            userId = task.UserId,
            deviceId,
            taskId = task.Id,
            executionId = execution.Id,
            eventType,
            status = JsonNamingPolicy.CamelCase.ConvertName(task.Status.ToString()),
            details = safePayload,
            pendingUserInput,
            occurredAt = nowMs,
            entityVersion = task.Version
        };
        db.TaskEvents.Add(TaskEvent.Create(
            Guid.CreateVersion7(),
            task.Id,
            sequence,
            eventType,
            JsonSerializer.Serialize(payload, JsonOptions),
            nowMs,
            deviceId,
            execution.Id));
        AddOutbox("task.updated", payload, nowMs);
        AddOutbox("task.eventAdded", payload, nowMs);
    }

    private void AddOutbox(string eventType, object payload, long nowMs)
    {
        var id = Guid.CreateVersion7();
        db.OutboxMessages.Add(OutboxMessage.Create(
            id,
            eventType,
            JsonSerializer.Serialize(new { eventId = id, occurredAt = nowMs, type = eventType, payload }, JsonOptions),
            nowMs));
        JarvisTelemetry.RecordOutboxEnqueued(eventType);
    }

    private static DeviceTaskUserInputResponse ToDeviceResponse(TaskUserInputRequest request, bool includeAnswers) => new(
        request.TaskId,
        request.ExecutionId,
        request.RequestId,
        request.ItemId,
        request.ThreadId,
        request.TurnId,
        DeserializeQuestions(request.QuestionsJson),
        (TaskUserInputStatusValue)request.Status,
        includeAnswers && request.AnswersJson is not null ? DeserializeAnswers(request.AnswersJson) : null,
        request.ExpiresAtMs,
        request.RequestIdIsString);

    private static TaskUserInputResponse ToTaskResponse(TaskUserInputRequest request) => new(
        request.RequestId,
        request.ItemId,
        request.ThreadId,
        request.TurnId,
        DeserializeQuestions(request.QuestionsJson),
        TaskUserInputStatusValue.Pending,
        request.ExpiresAtMs,
        request.RequestIdIsString);

    private static TaskUserInputQuestion[] DeserializeQuestions(string json)
    {
        try
        {
            return JsonSerializer.Deserialize<TaskUserInputQuestion[]>(json, JsonOptions) ?? [];
        }
        catch (JsonException)
        {
            return [];
        }
    }

    private static Dictionary<string, TaskUserInputAnswer>? DeserializeAnswers(string json)
    {
        try
        {
            return JsonSerializer.Deserialize<Dictionary<string, TaskUserInputAnswer>>(json, JsonOptions);
        }
        catch (JsonException)
        {
            return null;
        }
    }

    private static string Hash<T>(T value) => Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(JsonSerializer.Serialize(value, JsonOptions))));

    private long Now() => timeProvider.GetUtcNow().ToUnixTimeMilliseconds();

    private static TaskUserInputOperation<T> Invalid<T>(string detail) => new(TaskUserInputOperationStatus.Invalid, Detail: detail);

    private static TaskStatusValue ToTaskStatus(DomainTaskStatus status) => (TaskStatusValue)status;

    private static TaskExecutionStatusValue ToExecutionStatus(TaskExecutionStatus status) => (TaskExecutionStatusValue)status;
}
