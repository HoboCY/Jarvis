using System.Data;
using System.Text.Json;
using Jarvis.Domain.Approvals;
using Jarvis.Domain.Notifications;
using Jarvis.Domain.Outbox;
using Jarvis.Infrastructure.Data;
using Jarvis.Infrastructure.Observability;
using Jarvis.Infrastructure.Tasks;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;
using DomainTaskStatus = Jarvis.Domain.Tasks.TaskStatus;
using DomainTaskExecutionStatus = Jarvis.Domain.Tasks.TaskExecutionStatus;
using DomainTaskUserInputStatus = Jarvis.Domain.Tasks.TaskUserInputRequestStatus;
using DomainWorkerKind = Jarvis.Domain.Tasks.WorkerKind;

namespace Jarvis.Infrastructure.Devices;

public sealed class DeviceLeaseRecoveryService(
    JarvisDbContext db,
    EfTaskStore taskStore,
    TimeProvider timeProvider)
{
    private static readonly JsonSerializerOptions JsonOptions = new(JsonSerializerDefaults.Web);

    public async Task<int> RecoverExpiredAsync(CancellationToken cancellationToken = default)
    {
        var nowMs = timeProvider.GetUtcNow().ToUnixTimeMilliseconds();
        await using var transaction = await db.Database.BeginTransactionAsync(
            IsolationLevel.Serializable,
            cancellationToken);
        var tasks = await db.Tasks
            .Where(task => task.WorkerKind == DomainWorkerKind.Codex
                && task.LeaseExpiresAtMs != null
                && task.LeaseExpiresAtMs <= nowMs
                && (task.Status == DomainTaskStatus.Assigned
                    || task.Status == DomainTaskStatus.Running
                    || task.Status == DomainTaskStatus.WaitingForApproval
                    || task.Status == DomainTaskStatus.WaitingForUserInput
                    || task.Status == DomainTaskStatus.CancellationRequested))
            .ToListAsync(cancellationToken);
        var expiredApprovals = await db.Approvals
            .Where(approval => approval.Status == ApprovalStatus.Pending
                && approval.ExpiresAtMs != null
                && approval.ExpiresAtMs <= nowMs)
            .ToListAsync(cancellationToken);
        var expiredUserInputs = await db.TaskUserInputRequests
            .Where(request => request.Status == DomainTaskUserInputStatus.Pending
                && request.ExpiresAtMs != null
                && request.ExpiresAtMs <= nowMs)
            .ToListAsync(cancellationToken);
        if (tasks.Count == 0 && expiredApprovals.Count == 0 && expiredUserInputs.Count == 0)
        {
            await transaction.CommitAsync(cancellationToken);
            return 0;
        }

        var recoveredCount = 0;
        foreach (var task in tasks.Where(item => item.Status == DomainTaskStatus.CancellationRequested))
        {
            var cancellationExecutions = await db.TaskExecutions
                .Where(execution => execution.TaskId == task.Id
                    && execution.Status != DomainTaskExecutionStatus.Succeeded
                    && execution.Status != DomainTaskExecutionStatus.Failed
                    && execution.Status != DomainTaskExecutionStatus.Cancelled)
                .ToListAsync(cancellationToken);
            var pendingCancellationInputs = await db.TaskUserInputRequests
                .Where(request => request.TaskId == task.Id && request.Status == DomainTaskUserInputStatus.Pending)
                .ToListAsync(cancellationToken);

            foreach (var pendingUserInput in pendingCancellationInputs)
            {
                pendingUserInput.Clear(nowMs);
                taskStore.MarkUserInputNotificationActioned(task, pendingUserInput.RequestId, nowMs);
            }

            if (task.ConfirmCancellation(nowMs))
            {
                recoveredCount++;
                foreach (var execution in cancellationExecutions)
                {
                    execution.MarkCancelled(nowMs);
                }

                taskStore.AddTaskEventAndOutbox(task, "task.cancelled", nowMs);
                AddTaskCancelledOutbox(task, cancellationExecutions.FirstOrDefault()?.Id, nowMs);
                taskStore.AddTerminalNotification(
                    task,
                    "task.cancelled",
                    NotificationSeverity.Info,
                    "后台任务已取消",
                    "The device lease expired while cancellation was pending.",
                    nowMs);
            }
        }

        foreach (var approval in expiredApprovals)
        {
            approval.Expire(nowMs);
            var task = await db.Tasks.SingleOrDefaultAsync(item => item.Id == approval.TaskId, cancellationToken);
            var execution = approval.ExecutionId is Guid executionId
                ? await db.TaskExecutions.SingleOrDefaultAsync(item => item.Id == executionId, cancellationToken)
                : null;
            if (task is not null
                && execution is not null
                && task.Status == DomainTaskStatus.WaitingForApproval
                && execution.Status == DomainTaskExecutionStatus.WaitingForApproval)
            {
                task.MarkApprovalFailed(
                    "approval_expired",
                    "The approval expired before a decision was recorded.",
                    nowMs);
                execution.MarkFailed("{\"reason\":\"approval_expired\"}", nowMs);
                taskStore.AddTaskEventAndOutbox(task, "approval.expired", nowMs);
                taskStore.AddTerminalNotification(
                    task,
                    "task.failed",
                    NotificationSeverity.Error,
                    "后台任务审批已过期",
                    "审批在用户决定前已过期。",
                    nowMs);
                var notification = await db.Notifications.SingleOrDefaultAsync(
                    item => item.ApprovalId == approval.Id,
                    cancellationToken);
                notification?.MarkActioned(nowMs);
                AddApprovalResolvedOutbox(task, approval, execution.Id, nowMs);
            }
        }

        foreach (var userInput in expiredUserInputs)
        {
            var task = await db.Tasks.SingleOrDefaultAsync(item => item.Id == userInput.TaskId, cancellationToken);
            var execution = await db.TaskExecutions.SingleOrDefaultAsync(item => item.Id == userInput.ExecutionId, cancellationToken);
            if (!userInput.Expire(nowMs))
            {
                continue;
            }

            if (task is null || execution is null)
            {
                continue;
            }

            taskStore.FailClosedUserInput(
                task,
                execution,
                "codex_user_input_expired",
                "The Codex user-input request expired before it was answered.",
                nowMs);
            taskStore.MarkUserInputNotificationActioned(task, userInput.RequestId, nowMs, "userInputExpired");
            taskStore.AddTaskEventAndOutbox(task, "task.userInputExpired", nowMs);
            AddUserInputExpiredOutbox(task, execution.Id, userInput.RequestId, nowMs);
        }

        var taskIds = tasks.Select(task => task.Id).ToArray();
        var activeExecutions = await db.TaskExecutions
            .Where(execution => taskIds.Contains(execution.TaskId)
                && execution.Status != DomainTaskExecutionStatus.Succeeded
                && execution.Status != DomainTaskExecutionStatus.Failed
                && execution.Status != DomainTaskExecutionStatus.Cancelled)
            .ToListAsync(cancellationToken);
        var pendingApprovals = await db.Approvals
            .Where(approval => taskIds.Contains(approval.TaskId)
                && approval.Status == ApprovalStatus.Pending)
            .ToListAsync(cancellationToken);

        foreach (var task in tasks)
        {
            if (task.Status is not (DomainTaskStatus.Assigned
                or DomainTaskStatus.Running
                or DomainTaskStatus.WaitingForApproval
                or DomainTaskStatus.WaitingForUserInput))
            {
                continue;
            }

            task.MarkRecovering(nowMs);
            recoveredCount++;
            foreach (var execution in activeExecutions.Where(item => item.TaskId == task.Id))
            {
                execution.MarkRecovering(nowMs);
            }

            foreach (var approval in pendingApprovals.Where(item => item.TaskId == task.Id))
            {
                approval.Cancel(nowMs);
            }

            taskStore.AddTaskEventAndOutbox(task, "task.recovering", nowMs);
            taskStore.AddTerminalNotification(
                task,
                "task.recovering",
                NotificationSeverity.Warning,
                "后台执行器连接中断",
                "设备租约已过期，任务正在等待安全恢复。",
                nowMs);
        }

        try
        {
            await db.SaveChangesAsync(cancellationToken);
            await transaction.CommitAsync(cancellationToken);
            if (recoveredCount > 0)
            {
                JarvisTelemetry.TaskRecoveries.Add(
                    recoveredCount,
                    JarvisTelemetry.BoundedTags(("worker.kind", "codex"), ("operation", "device_lease_expired")).ToArray());
                JarvisTelemetry.TaskLeaseExpiries.Add(
                    recoveredCount,
                    JarvisTelemetry.BoundedTags(("worker.kind", "codex")).ToArray());
                JarvisTelemetry.TaskQueueDepth.Add(
                    recoveredCount,
                    JarvisTelemetry.BoundedTags(("worker.kind", "codex"), ("operation", "recover")).ToArray());
            }
            return recoveredCount;
        }
        catch (DbUpdateConcurrencyException)
        {
            await transaction.RollbackAsync(cancellationToken);
            return 0;
        }
    }

    private void AddApprovalResolvedOutbox(
        Jarvis.Domain.Tasks.Task task,
        Approval approval,
        Guid executionId,
        long nowMs)
    {
        var eventId = Guid.CreateVersion7();
        var payload = new
        {
            eventId,
            occurredAt = nowMs,
            type = "approval.resolved",
            payload = new
            {
                userId = task.UserId,
                deviceId = approval.DeviceId,
                taskId = task.Id,
                executionId,
                approvalId = approval.Id,
                decision = "expired",
                occurredAt = nowMs,
                entityVersion = task.Version
            }
        };
        db.OutboxMessages.Add(OutboxMessage.Create(
            eventId,
            "approval.resolved",
            JsonSerializer.Serialize(payload, JsonOptions),
            nowMs));
        JarvisTelemetry.RecordOutboxEnqueued("approval.resolved");
    }

    private void AddUserInputExpiredOutbox(
        Jarvis.Domain.Tasks.Task task,
        Guid executionId,
        string requestId,
        long nowMs)
    {
        AddOutbox("task.userInputExpired", new
        {
            userId = task.UserId,
            deviceId = task.AssignedDeviceId,
            taskId = task.Id,
            executionId,
            requestId,
            occurredAt = nowMs,
            entityVersion = task.Version
        }, nowMs);
    }

    private void AddTaskCancelledOutbox(
        Jarvis.Domain.Tasks.Task task,
        Guid? executionId,
        long nowMs)
    {
        AddOutbox("task.cancelled", new
        {
            userId = task.UserId,
            deviceId = task.AssignedDeviceId,
            taskId = task.Id,
            executionId,
            occurredAt = nowMs,
            entityVersion = task.Version,
            pendingUserInput = (object?)null
        }, nowMs);
    }

    private void AddOutbox(string eventType, object payload, long nowMs)
    {
        var eventId = Guid.CreateVersion7();
        db.OutboxMessages.Add(OutboxMessage.Create(
            eventId,
            eventType,
            JsonSerializer.Serialize(new { eventId, occurredAt = nowMs, type = eventType, payload }, JsonOptions),
            nowMs));
        JarvisTelemetry.RecordOutboxEnqueued(eventType);
    }
}

public sealed partial class DeviceLeaseRecoveryHostedService(
    IServiceScopeFactory scopeFactory,
    ILogger<DeviceLeaseRecoveryHostedService> logger) : BackgroundService
{
    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        using var timer = new PeriodicTimer(TimeSpan.FromSeconds(5));
        while (await timer.WaitForNextTickAsync(stoppingToken))
        {
            try
            {
                await using var scope = scopeFactory.CreateAsyncScope();
                await scope.ServiceProvider
                    .GetRequiredService<DeviceLeaseRecoveryService>()
                    .RecoverExpiredAsync(stoppingToken);
            }
            catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested)
            {
                break;
            }
            catch (Exception exception)
            {
                LogRecoveryFailure(logger, exception);
            }
        }
    }

    [LoggerMessage(
        EventId = 4101,
        Level = LogLevel.Error,
        Message = "The expired Device Node lease recovery cycle failed.")]
    private static partial void LogRecoveryFailure(ILogger logger, Exception exception);
}
