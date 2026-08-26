using System.Data;
using System.Data.Common;
using Jarvis.Application.Tasks;
using Jarvis.Domain.Notifications;
using Jarvis.Infrastructure.Data;
using Microsoft.Data.Sqlite;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;
using DomainTask = Jarvis.Domain.Tasks.Task;
using DomainTaskStatus = Jarvis.Domain.Tasks.TaskStatus;
using DomainWorkerKind = Jarvis.Domain.Tasks.WorkerKind;

namespace Jarvis.Infrastructure.Tasks;

public sealed class FakeDelayWorker(
    JarvisDbContext db,
    EfTaskStore taskStore,
    IFakeDelayAdapter adapter,
    TimeProvider timeProvider,
    IOptions<FakeDelayOptions> options,
    IServiceScopeFactory scopeFactory) : IDisposable
{
    private const int MaxWriteAttempts = 5;
    private const string MaxAttemptsErrorCode = "fake_worker_max_attempts_exceeded";
    private const string MaxAttemptsErrorMessage = "Fake worker exhausted the maximum execution attempts.";
    private readonly SemaphoreSlim processGate = new(1, 1);
    private readonly Guid? workerDeviceId = ParseWorkerDeviceId(options.Value.WorkerDeviceId);

    public string WorkerId { get; } = $"fake-worker-{Guid.CreateVersion7():N}";

    public async Task<bool> ProcessOneAsync(CancellationToken cancellationToken = default)
    {
        await processGate.WaitAsync(cancellationToken);
        try
        {
            for (var attempt = 1; ; attempt++)
            {
                var nowMs = timeProvider.GetUtcNow().ToUnixTimeMilliseconds();
                var candidate = await FindCandidateAsync(nowMs, cancellationToken);
                if (candidate is null)
                {
                    return false;
                }

                PrepareResult prepared;
                try
                {
                    prepared = await PrepareAsync(candidate.Id, nowMs, cancellationToken);
                }
                catch (Exception exception) when (attempt < MaxWriteAttempts && IsRecognizedWriteRace(exception))
                {
                    db.ChangeTracker.Clear();
                    await Task.Delay(TimeSpan.FromMilliseconds(10L * attempt), cancellationToken);
                    continue;
                }

                if (!prepared.Handled)
                {
                    return false;
                }

                if (!prepared.Execute)
                {
                    return true;
                }

                FakeWorkResult result;
                var renewalFailed = false;
                using var executionCts = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
                var renewalTask = RenewLeaseLoopAsync(candidate.Id, executionCts);
                try
                {
                    result = await adapter.ExecuteAsync(
                        new FakeWorkItem(candidate.Id, candidate.Goal, candidate.ExpectedOutput, candidate.WorkerKind),
                        executionCts.Token);
                }
                catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
                {
                    // Leave a running task durable. A new hosted loop can continue it after restart.
                    throw;
                }
                catch (OperationCanceledException)
                {
                    result = new(
                        false,
                        "Fake worker execution was cancelled.",
                        ErrorCode: "fake_worker_cancelled",
                        ErrorMessage: "Fake worker execution was cancelled before completion.");
                }
                catch (Exception exception)
                {
                    result = new(false, "Fake worker failed.", ErrorCode: "fake_worker_error", ErrorMessage: exception.Message);
                }
                finally
                {
                    executionCts.Cancel();
                    renewalFailed = !await renewalTask;
                }

                if (renewalFailed)
                {
                    // The adapter was cooperatively stopped after lease loss or a
                    // renewal fault. Leave the durable Running task for recovery;
                    // never persist a result produced without lease protection.
                    if (!await IsCancellationRequestedAsync(candidate.Id, cancellationToken))
                    {
                        return true;
                    }
                }

                await CompleteWithRetryAsync(candidate.Id, result, cancellationToken);
                return true;
            }
        }
        finally
        {
            processGate.Release();
        }
    }

    private async Task<DomainTask?> FindCandidateAsync(long nowMs, CancellationToken cancellationToken)
    {
        var candidates = await db.Tasks
            .AsNoTracking()
            .Where(task => task.Status == DomainTaskStatus.Queued
                || task.Status == DomainTaskStatus.Assigned
                || task.Status == DomainTaskStatus.Running
                || task.Status == DomainTaskStatus.Recovering
                || task.Status == DomainTaskStatus.CancellationRequested)
            .OrderBy(task => task.Priority)
            .ThenBy(task => task.CreatedAtMs)
            .ToListAsync(cancellationToken);

        return candidates.FirstOrDefault(task => IsDeviceEligible(task)
            && task.WorkerKind == DomainWorkerKind.Internal
            && (task.Status is DomainTaskStatus.Queued or DomainTaskStatus.Recovering
                || task.LeaseOwner == WorkerId
                || !IsLeaseValid(task, nowMs)));
    }

    private async Task<PrepareResult> PrepareAsync(Guid taskId, long nowMs, CancellationToken cancellationToken)
    {
        db.ChangeTracker.Clear();
        await using var transaction = await db.Database.BeginTransactionAsync(IsolationLevel.Serializable, cancellationToken);
        var task = await db.Tasks.SingleOrDefaultAsync(item => item.Id == taskId, cancellationToken);
        if (task is null || task.Status is DomainTaskStatus.Succeeded or DomainTaskStatus.Failed or DomainTaskStatus.Cancelled)
        {
            return PrepareResult.NotHandled;
        }

        if (!IsDeviceEligible(task))
        {
            return PrepareResult.NotHandled;
        }

        // Responses tasks are handled by ResponsesWorker and Codex tasks by an
        // authenticated Device Node. The fake adapter is intentionally limited
        // to the durable Internal worker seam.
        if (task.WorkerKind != DomainWorkerKind.Internal)
        {
            return PrepareResult.NotHandled;
        }

        if (task.Status == DomainTaskStatus.CancellationRequested)
        {
            if (task.LeaseOwner != WorkerId && IsLeaseValid(task, nowMs))
            {
                return PrepareResult.NotHandled;
            }

            task.ConfirmCancellation(nowMs);
            taskStore.AddTaskEventAndOutbox(task, "task.cancelled", nowMs);
            taskStore.AddTerminalNotification(
                task,
                "task.cancelled",
                NotificationSeverity.Info,
                "后台任务已取消",
                "Fake worker confirmed cancellation.",
                nowMs);
            await db.SaveChangesAsync(cancellationToken);
            await transaction.CommitAsync(cancellationToken);
            return new(true, false);
        }

        if (task.Status is DomainTaskStatus.Assigned or DomainTaskStatus.Running
            && task.LeaseOwner != WorkerId
            && IsLeaseValid(task, nowMs))
        {
            return PrepareResult.NotHandled;
        }

        if (task.Status is DomainTaskStatus.Assigned or DomainTaskStatus.Running
            && !IsLeaseValid(task, nowMs))
        {
            task.MarkRecovering(nowMs);
            taskStore.AddTaskEventAndOutbox(task, "task.recovering", nowMs);
        }

        if (task.Status == DomainTaskStatus.Recovering && task.Attempt >= task.MaxAttempts)
        {
            task.MarkFailed(MaxAttemptsErrorCode, MaxAttemptsErrorMessage, nowMs);
            taskStore.AddTaskEventAndOutbox(task, "task.failed", nowMs);
            taskStore.AddTerminalNotification(
                task,
                "task.failed",
                NotificationSeverity.Error,
                "后台任务失败",
                MaxAttemptsErrorMessage,
                nowMs);
            await db.SaveChangesAsync(cancellationToken);
            await transaction.CommitAsync(cancellationToken);
            return new(true, false);
        }

        if (task.Status is DomainTaskStatus.Queued or DomainTaskStatus.Recovering)
        {
            task.Assign(WorkerId, checked(nowMs + FakeDelayOptions.LeaseDurationMs), nowMs, task.PreferredDeviceId);
            taskStore.AddTaskEventAndOutbox(task, "task.assigned", nowMs);
        }

        if (task.Status == DomainTaskStatus.Assigned)
        {
            task.Start(nowMs);
            taskStore.AddTaskEventAndOutbox(task, "task.running", nowMs);
        }

        if (task.Status == DomainTaskStatus.Running)
        {
            task.MarkProgress("Fake worker started.", nowMs);
            taskStore.AddTaskEventAndOutbox(task, "task.progress", nowMs);
        }

        await db.SaveChangesAsync(cancellationToken);
        await transaction.CommitAsync(cancellationToken);
        return new(true, true);
    }

    private async Task CompleteWithRetryAsync(Guid taskId, FakeWorkResult result, CancellationToken cancellationToken)
    {
        for (var attempt = 1; ; attempt++)
        {
            try
            {
                await CompleteAsync(taskId, result, cancellationToken);
                return;
            }
            catch (Exception exception) when (attempt < MaxWriteAttempts && IsRecognizedWriteRace(exception))
            {
                db.ChangeTracker.Clear();
                await Task.Delay(TimeSpan.FromMilliseconds(10L * attempt), cancellationToken);
            }
        }
    }

    private async Task CompleteAsync(Guid taskId, FakeWorkResult result, CancellationToken cancellationToken)
    {
        db.ChangeTracker.Clear();
        await using var transaction = await db.Database.BeginTransactionAsync(IsolationLevel.Serializable, cancellationToken);
        var task = await db.Tasks.SingleOrDefaultAsync(item => item.Id == taskId, cancellationToken);
        if (task is null || task.Status is DomainTaskStatus.Succeeded or DomainTaskStatus.Failed or DomainTaskStatus.Cancelled)
        {
            return;
        }

        if (task.LeaseOwner != WorkerId)
        {
            return;
        }

        if (task.Status is not (DomainTaskStatus.Running or DomainTaskStatus.CancellationRequested))
        {
            return;
        }

        var nowMs = timeProvider.GetUtcNow().ToUnixTimeMilliseconds();
        if (task.LeaseExpiresAtMs is not long leaseExpiresAtMs || leaseExpiresAtMs <= nowMs)
        {
            return;
        }

        if (task.Status == DomainTaskStatus.CancellationRequested)
        {
            task.ConfirmCancellation(nowMs);
            taskStore.AddTaskEventAndOutbox(task, "task.cancelled", nowMs);
            taskStore.AddTerminalNotification(
                task,
                "task.cancelled",
                NotificationSeverity.Info,
                "后台任务已取消",
                "Fake worker confirmed cancellation.",
                nowMs);
        }
        else if (result.Succeeded)
        {
            task.MarkSucceeded(result.ResultSummary, nowMs, result.ResultPayloadJson);
            taskStore.AddTaskEventAndOutbox(task, "task.succeeded", nowMs);
            taskStore.AddTerminalNotification(
                task,
                "task.completed",
                NotificationSeverity.Success,
                "后台任务已完成",
                result.ResultSummary,
                nowMs);
        }
        else
        {
            task.MarkFailed(
                result.ErrorCode ?? "fake_worker_failed",
                result.ErrorMessage ?? "Fake worker failed.",
                nowMs);
            taskStore.AddTaskEventAndOutbox(task, "task.failed", nowMs);
            taskStore.AddTerminalNotification(
                task,
                "task.failed",
                NotificationSeverity.Error,
                "后台任务失败",
                task.ErrorMessage ?? "Fake worker failed.",
                nowMs);
        }

        await db.SaveChangesAsync(cancellationToken);
        await transaction.CommitAsync(cancellationToken);
    }

    private async Task<bool> RenewLeaseLoopAsync(Guid taskId, CancellationTokenSource executionCts)
    {
        try
        {
            while (true)
            {
                await Task.Delay(
                    Math.Clamp(options.Value.LeaseRenewalIntervalMs, 1, 60_000),
                    executionCts.Token);
                if (!await RenewLeaseWithRetryAsync(taskId, executionCts.Token))
                {
                    executionCts.Cancel();
                    return false;
                }
            }
        }
        catch (OperationCanceledException) when (executionCts.IsCancellationRequested)
        {
            // Adapter completion, host cancellation, or a lost lease stops renewal.
            return true;
        }
        catch (Exception)
        {
            // Unknown database/EF failures fail closed. The adapter observes the
            // cancellation and the task remains recoverable instead of being
            // completed from an unprotected execution.
            executionCts.Cancel();
            return false;
        }
    }

    private async Task<bool> RenewLeaseWithRetryAsync(Guid taskId, CancellationToken cancellationToken)
    {
        for (var attempt = 1; ; attempt++)
        {
            try
            {
                await using var scope = scopeFactory.CreateAsyncScope();
                var renewalDb = scope.ServiceProvider.GetRequiredService<JarvisDbContext>();
                await using var transaction = await renewalDb.Database
                    .BeginTransactionAsync(IsolationLevel.Serializable, cancellationToken);
                var task = await renewalDb.Tasks.SingleOrDefaultAsync(item => item.Id == taskId, cancellationToken);
                if (task is null)
                {
                    return false;
                }

                var nowMs = timeProvider.GetUtcNow().ToUnixTimeMilliseconds();
                if (!task.RenewLease(WorkerId, checked(nowMs + FakeDelayOptions.LeaseDurationMs), nowMs))
                {
                    return false;
                }

                await renewalDb.SaveChangesAsync(cancellationToken);
                await transaction.CommitAsync(cancellationToken);
                return true;
            }
            catch (Exception exception) when (attempt < MaxWriteAttempts && IsRecognizedWriteRace(exception))
            {
                await Task.Delay(TimeSpan.FromMilliseconds(10L * attempt), cancellationToken);
            }
        }
    }

    private async Task<bool> IsCancellationRequestedAsync(Guid taskId, CancellationToken cancellationToken)
    {
        try
        {
            db.ChangeTracker.Clear();
            return await db.Tasks
                .AsNoTracking()
                .Where(task => task.Id == taskId)
                .Select(task => task.Status)
                .SingleOrDefaultAsync(cancellationToken) == DomainTaskStatus.CancellationRequested;
        }
        catch (Exception exception) when (IsRecognizedWriteRace(exception))
        {
            return false;
        }
    }

    private bool IsDeviceEligible(DomainTask task)
    {
        if (workerDeviceId is null)
        {
            return true;
        }

        var assignedDeviceId = task.AssignedDeviceId ?? task.PreferredDeviceId;
        return assignedDeviceId is null || assignedDeviceId == workerDeviceId;
    }

    private static bool IsLeaseValid(DomainTask task, long nowMs) =>
        task.LeaseExpiresAtMs is long leaseExpiresAtMs && leaseExpiresAtMs > nowMs;

    private static Guid? ParseWorkerDeviceId(string? value)
    {
        if (string.IsNullOrWhiteSpace(value))
        {
            return null;
        }

        if (!Guid.TryParse(value, out var workerDeviceId) || workerDeviceId == Guid.Empty)
        {
            throw new InvalidOperationException(
                "FakeWorker:WorkerDeviceId must be empty or a non-empty GUID.");
        }

        return workerDeviceId;
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

    private sealed record PrepareResult(bool Handled, bool Execute)
    {
        public static PrepareResult NotHandled { get; } = new(false, false);
    }

    public void Dispose() => processGate.Dispose();
}

public sealed partial class FakeDelayWorkerHostedService(
    IServiceScopeFactory scopeFactory,
    IOptions<FakeDelayOptions> options,
    ILogger<FakeDelayWorkerHostedService> logger) : BackgroundService
{
    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        if (!options.Value.Enabled)
        {
            return;
        }

        while (!stoppingToken.IsCancellationRequested)
        {
            try
            {
                await using var scope = scopeFactory.CreateAsyncScope();
                var worker = scope.ServiceProvider.GetRequiredService<FakeDelayWorker>();
                await worker.ProcessOneAsync(stoppingToken);
            }
            catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested)
            {
                break;
            }
            catch (Exception exception)
            {
                LogCycleFailed(logger, exception);
            }

            await Task.Delay(
                Math.Clamp(options.Value.PollingIntervalMs, 25, 60_000),
                stoppingToken);
        }
    }

    [LoggerMessage(EventId = 3201, Level = LogLevel.Error, Message = "Fake worker cycle failed.")]
    private static partial void LogCycleFailed(ILogger logger, Exception exception);
}
