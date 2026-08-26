using System.Data;
using System.Data.Common;
using System.Text.Json;
using Jarvis.Application.Responses;
using Jarvis.Domain.Notifications;
using Jarvis.Domain.Tasks;
using Jarvis.Infrastructure.Data;
using Jarvis.Infrastructure.Observability;
using Jarvis.Infrastructure.Realtime;
using Microsoft.Data.Sqlite;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;
using Task = System.Threading.Tasks.Task;
using DomainTask = Jarvis.Domain.Tasks.Task;
using DomainTaskStatus = Jarvis.Domain.Tasks.TaskStatus;
using DomainWorkerKind = Jarvis.Domain.Tasks.WorkerKind;

namespace Jarvis.Infrastructure.Tasks;

/// <summary>
/// Identifies one Responses worker process. It is registered as a singleton so
/// the hosted service can create a scope for every poll without changing the
/// lease owner between polls.
/// </summary>
public sealed class ResponsesWorkerIdentity
{
    public string Value { get; } = $"responses-worker-{Guid.CreateVersion7():N}";
}

public sealed class ResponsesWorker(
    JarvisDbContext db,
    EfTaskStore taskStore,
    IResponsesRuntime runtime,
    TimeProvider timeProvider,
    IOptions<ResponsesWorkerOptions> options,
    IOptions<OpenAiRealtimeOptions> openAiOptions,
    ResponsesWorkerIdentity identity) : IDisposable
{
    private const int MaxWriteAttempts = 5;
    private const string LeaseLostErrorCode = "responses_lease_lost";
    private const string ProviderFailedErrorCode = "responses_failed";
    private const string ProviderIncompleteErrorCode = "responses_incomplete";
    private readonly SemaphoreSlim processGate = new(1, 1);

    public string WorkerId => identity.Value;

    public async Task<bool> ProcessOneAsync(CancellationToken cancellationToken = default)
    {
        await processGate.WaitAsync(cancellationToken);
        try
        {
            for (var attempt = 1; ; attempt++)
            {
                var candidate = await FindCandidateAsync(
                    timeProvider.GetUtcNow().ToUnixTimeMilliseconds(),
                    cancellationToken);
                if (candidate is null)
                {
                    return false;
                }

                try
                {
                    var prepared = await PrepareAsync(candidate.Id, cancellationToken);
                    if (!prepared.Handled)
                    {
                        return false;
                    }

                    if (!prepared.Execute)
                    {
                        return true;
                    }

                    await ExecuteAsync(prepared, cancellationToken);
                    return true;
                }
                catch (Exception exception) when (attempt < MaxWriteAttempts && IsWriteRace(exception))
                {
                    db.ChangeTracker.Clear();
                    await Task.Delay(TimeSpan.FromMilliseconds(10L * attempt), cancellationToken);
                }
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
            .Where(task => task.WorkerKind == DomainWorkerKind.Responses
                && (task.Status == DomainTaskStatus.Queued
                    || task.Status == DomainTaskStatus.Assigned
                    || task.Status == DomainTaskStatus.Running
                    || task.Status == DomainTaskStatus.Recovering
                    || task.Status == DomainTaskStatus.CancellationRequested))
            .OrderBy(task => task.Priority)
            .ThenBy(task => task.CreatedAtMs)
            .ToListAsync(cancellationToken);
        return candidates.FirstOrDefault(task => task.Status is DomainTaskStatus.Queued or DomainTaskStatus.Recovering
            || task.LeaseOwner == WorkerId
            || task.LeaseExpiresAtMs is not long expiresAtMs
            || expiresAtMs <= nowMs);
    }

    private async Task<PrepareResult> PrepareAsync(Guid taskId, CancellationToken cancellationToken)
    {
        db.ChangeTracker.Clear();
        await using var transaction = await db.Database.BeginTransactionAsync(IsolationLevel.Serializable, cancellationToken);
        var nowMs = timeProvider.GetUtcNow().ToUnixTimeMilliseconds();
        var task = await db.Tasks.SingleOrDefaultAsync(item => item.Id == taskId, cancellationToken);
        if (task is null
            || task.WorkerKind != DomainWorkerKind.Responses
            || task.Status is DomainTaskStatus.Succeeded or DomainTaskStatus.Failed or DomainTaskStatus.Cancelled)
        {
            return PrepareResult.NotHandled;
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
            JarvisTelemetry.TaskRecoveries.Add(
                1,
                JarvisTelemetry.BoundedTags(("worker.kind", "responses"), ("operation", "lease_expired")).ToArray());
            JarvisTelemetry.TaskLeaseExpiries.Add(
                1,
                JarvisTelemetry.BoundedTags(("worker.kind", "responses")).ToArray());
            JarvisTelemetry.TaskQueueDepth.Add(
                1,
                JarvisTelemetry.BoundedTags(("worker.kind", "responses"), ("operation", "recover")).ToArray());
        }

        if (task.Status == DomainTaskStatus.Recovering && task.Attempt >= task.MaxAttempts)
        {
            task.MarkFailed("responses_max_attempts_exceeded", "Responses worker exhausted the maximum execution attempts.", nowMs);
            taskStore.AddTaskEventAndOutbox(task, "task.failed", nowMs);
            taskStore.AddTerminalNotification(
                task,
                "task.failed",
                NotificationSeverity.Error,
                "后台任务失败",
                task.ErrorMessage!,
                nowMs);
            await db.SaveChangesAsync(cancellationToken);
            await transaction.CommitAsync(cancellationToken);
            return new(true, false, task.Id, null, null, false);
        }

        if (task.Status is DomainTaskStatus.Queued or DomainTaskStatus.Recovering)
        {
            JarvisTelemetry.TaskQueueWaitDuration.Record(
                Math.Max(0, nowMs - task.CreatedAtMs),
                JarvisTelemetry.BoundedTags(("worker.kind", "responses")).ToArray());
            JarvisTelemetry.TaskQueueDepth.Add(
                -1,
                JarvisTelemetry.BoundedTags(("worker.kind", "responses"), ("operation", "dequeue")).ToArray());
            task.Assign(WorkerId, checked(nowMs + options.Value.LeaseDurationMs), nowMs);
            taskStore.AddTaskEventAndOutbox(task, "task.assigned", nowMs);
        }

        if (task.Status == DomainTaskStatus.Assigned)
        {
            task.Start(nowMs);
            taskStore.AddTaskEventAndOutbox(task, "task.running", nowMs);
        }

        var execution = await db.TaskExecutions
            .Where(item => item.TaskId == task.Id && item.WorkerKind == DomainWorkerKind.Responses)
            .OrderByDescending(item => item.StartedAtMs)
            .FirstOrDefaultAsync(cancellationToken);
        if (execution is null)
        {
            execution = TaskExecution.Create(Guid.CreateVersion7(), task.Id, null, DomainWorkerKind.Responses, nowMs);
            execution.SetMetadata(JsonSerializer.Serialize(new
            {
                createIntent = true,
                idempotencyKey = CreateIdempotencyKey(task.Id, execution.Id)
            }));
            db.TaskExecutions.Add(execution);
        }

        if (execution.Status == TaskExecutionStatus.Assigned)
        {
            execution.Start(nowMs);
        }

        var shouldCancel = task.Status == DomainTaskStatus.CancellationRequested;
        await db.SaveChangesAsync(cancellationToken);
        await transaction.CommitAsync(cancellationToken);
        return new(true, true, task.Id, execution.Id, execution.ExternalExecutionId, shouldCancel);
    }

    private async Task ExecuteAsync(PrepareResult prepared, CancellationToken cancellationToken)
    {
        var execution = await db.TaskExecutions.AsNoTracking().SingleOrDefaultAsync(
            item => item.Id == prepared.ExecutionId,
            cancellationToken);
        if (execution is null)
        {
            return;
        }

        ResponsesResult result;
        if (!await RenewLeaseAsync(prepared.TaskId, cancellationToken))
        {
            return;
        }

        if (prepared.CancellationRequested)
        {
            result = execution.ExternalExecutionId is null
                ? new(null, ResponsesStatus.Cancelled)
                : await runtime.CancelAsync(execution.ExternalExecutionId, cancellationToken);
        }
        else if (string.IsNullOrWhiteSpace(execution.ExternalExecutionId))
        {
            var task = await db.Tasks.AsNoTracking().SingleAsync(item => item.Id == prepared.TaskId, cancellationToken);
            result = await runtime.CreateAsync(
                new ResponsesCreateRequest(
                    ResolveModel(),
                    "Return a concise, user-safe text result. Do not claim unperformed actions.",
                    BuildInput(task.Goal, task.ExpectedOutput),
                    CreateIdempotencyKey(prepared.TaskId, prepared.ExecutionId!.Value)),
                cancellationToken);
            if (string.IsNullOrWhiteSpace(result.ResponseId))
            {
                result = new(
                    null,
                    ResponsesStatus.Failed,
                    ErrorCode: "responses_create_uncertain",
                    ErrorMessage: "The Responses provider did not return a response id after create.");
            }
            else
            {
                await PersistExternalIdAsync(prepared, result.ResponseId, cancellationToken);
            }
        }
        else
        {
            result = await runtime.RetrieveAsync(execution.ExternalExecutionId, cancellationToken);
        }

        if (result.Status == ResponsesStatus.Unknown)
        {
            result = result with
            {
                Status = ResponsesStatus.Failed,
                ErrorCode = "responses_unknown_status",
                ErrorMessage = "The Responses provider returned an unknown status."
            };
        }

        if (!result.IsTerminal)
        {
            return;
        }

        await CompleteAsync(prepared, result, cancellationToken);
    }

    private async Task PersistExternalIdAsync(
        PrepareResult prepared,
        string externalId,
        CancellationToken cancellationToken)
    {
        if (!await RenewLeaseAsync(prepared.TaskId, cancellationToken))
        {
            return;
        }

        db.ChangeTracker.Clear();
        await using var transaction = await db.Database.BeginTransactionAsync(IsolationLevel.Serializable, cancellationToken);
        var task = await db.Tasks.SingleOrDefaultAsync(item => item.Id == prepared.TaskId, cancellationToken);
        var execution = await db.TaskExecutions.SingleOrDefaultAsync(item => item.Id == prepared.ExecutionId, cancellationToken);
        var nowMs = timeProvider.GetUtcNow().ToUnixTimeMilliseconds();
        if (!HasLease(task, nowMs) || execution is null)
        {
            return;
        }

        execution.SetExternalExecutionId(externalId);
        await db.SaveChangesAsync(cancellationToken);
        await transaction.CommitAsync(cancellationToken);
    }

    private async Task CompleteAsync(
        PrepareResult prepared,
        ResponsesResult result,
        CancellationToken cancellationToken)
    {
        if (!await RenewLeaseAsync(prepared.TaskId, cancellationToken))
        {
            return;
        }

        db.ChangeTracker.Clear();
        await using var transaction = await db.Database.BeginTransactionAsync(IsolationLevel.Serializable, cancellationToken);
        var task = await db.Tasks.SingleOrDefaultAsync(item => item.Id == prepared.TaskId, cancellationToken);
        var execution = await db.TaskExecutions.SingleOrDefaultAsync(item => item.Id == prepared.ExecutionId, cancellationToken);
        var nowMs = timeProvider.GetUtcNow().ToUnixTimeMilliseconds();
        if (task is null || execution is null || !HasLease(task, nowMs))
        {
            return;
        }

        if (task.Status == DomainTaskStatus.CancellationRequested || result.Status == ResponsesStatus.Cancelled)
        {
            task.ConfirmCancellation(nowMs);
            if (execution.Status is not (TaskExecutionStatus.Succeeded or TaskExecutionStatus.Failed or TaskExecutionStatus.Cancelled))
            {
                execution.MarkCancelled(nowMs);
            }

            taskStore.AddTaskEventAndOutbox(task, "task.cancelled", nowMs);
            taskStore.AddTerminalNotification(
                task,
                "task.cancelled",
                NotificationSeverity.Info,
                "后台任务已取消",
                "Responses worker confirmed cancellation.",
                nowMs);
        }
        else if (result.Status == ResponsesStatus.Completed)
        {
            var output = string.IsNullOrWhiteSpace(result.OutputText) ? "Responses task completed." : result.OutputText.Trim();
            task.MarkSucceeded(output, nowMs, JsonSerializer.Serialize(new { outputText = output }));
            execution.MarkSucceeded(JsonSerializer.Serialize(new { outputText = output }), "[]", nowMs);
            taskStore.AddTaskEventAndOutbox(task, "task.succeeded", nowMs);
            taskStore.AddTerminalNotification(
                task,
                "task.completed",
                NotificationSeverity.Success,
                "后台任务已完成",
                output,
                nowMs);
        }
        else
        {
            var errorCode = result.Status == ResponsesStatus.Incomplete
                ? ProviderIncompleteErrorCode
                : result.ErrorCode == "responses_unknown_status"
                    ? "responses_unknown_status"
                    : ProviderFailedErrorCode;
            var message = SafeError(result);
            task.MarkFailed(errorCode, message, nowMs);
            execution.MarkFailed(JsonSerializer.Serialize(new { errorCode, message }), nowMs);
            taskStore.AddTaskEventAndOutbox(task, "task.failed", nowMs);
            taskStore.AddTerminalNotification(
                task,
                "task.failed",
                NotificationSeverity.Error,
                "后台任务失败",
                message,
                nowMs);
        }

        await db.SaveChangesAsync(cancellationToken);
        await transaction.CommitAsync(cancellationToken);
        var taskStatus = task.Status switch
        {
            DomainTaskStatus.Succeeded => "succeeded",
            DomainTaskStatus.Cancelled => "cancelled",
            DomainTaskStatus.Failed => "failed",
            _ => "unknown"
        };
        if (taskStatus == "succeeded")
        {
            JarvisTelemetry.TasksSucceeded.Add(
                1,
                JarvisTelemetry.BoundedTags(("worker.kind", "responses"), ("task.status", taskStatus)).ToArray());
        }
        else if (taskStatus == "cancelled")
        {
            JarvisTelemetry.TasksCancelled.Add(
                1,
                JarvisTelemetry.BoundedTags(("worker.kind", "responses"), ("task.status", taskStatus)).ToArray());
        }
        else if (taskStatus == "failed")
        {
            JarvisTelemetry.TasksFailed.Add(
                1,
                JarvisTelemetry.BoundedTags(("worker.kind", "responses"), ("task.status", taskStatus)).ToArray());
        }

        if (task.StartedAtMs is long startedAtMs)
        {
            JarvisTelemetry.TaskDuration.Record(
                Math.Max(0, nowMs - startedAtMs),
                JarvisTelemetry.BoundedTags(("worker.kind", "responses"), ("task.status", taskStatus)).ToArray());
        }
    }

    private bool HasLease(DomainTask? task, long nowMs) =>
        task is not null
        && task.WorkerKind == DomainWorkerKind.Responses
        && task.LeaseOwner == WorkerId
        && IsLeaseValid(task, nowMs);

    private static bool IsLeaseValid(DomainTask task, long nowMs) =>
        task.LeaseExpiresAtMs is long leaseExpiresAtMs && leaseExpiresAtMs > nowMs;

    private static string BuildInput(string goal, string? expectedOutput) =>
        string.IsNullOrWhiteSpace(expectedOutput)
            ? goal
            : $"Goal:\n{goal}\n\nExpected output:\n{expectedOutput}";

    private string ResolveModel() => openAiOptions.Value.ResponsesModel;

    private async Task<bool> RenewLeaseAsync(Guid taskId, CancellationToken cancellationToken)
    {
        db.ChangeTracker.Clear();
        await using var transaction = await db.Database.BeginTransactionAsync(IsolationLevel.Serializable, cancellationToken);
        var nowMs = timeProvider.GetUtcNow().ToUnixTimeMilliseconds();
        var task = await db.Tasks.SingleOrDefaultAsync(item => item.Id == taskId, cancellationToken);
        if (task is null || !HasLease(task, nowMs))
        {
            return false;
        }

        var renewed = task.Status == DomainTaskStatus.CancellationRequested
            ? task.RenewCancellationLease(WorkerId, checked(nowMs + options.Value.LeaseDurationMs), nowMs)
            : task.RenewLease(WorkerId, checked(nowMs + options.Value.LeaseDurationMs), nowMs);
        if (!renewed)
        {
            return false;
        }

        await db.SaveChangesAsync(cancellationToken);
        await transaction.CommitAsync(cancellationToken);
        return true;
    }

    private static string CreateIdempotencyKey(Guid taskId, Guid executionId) =>
        $"jarvis-task:{taskId:D}:responses:{executionId:D}";

    private static string SafeError(ResponsesResult result)
    {
        if (result.Status == ResponsesStatus.Incomplete)
        {
            return "The Responses provider returned an incomplete result.";
        }

        return result.ErrorCode == "responses_unknown_status"
            ? "The Responses provider returned an unknown status."
            : "The Responses provider failed to complete the task.";
    }

    private static bool IsWriteRace(Exception exception)
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

    private sealed record PrepareResult(
        bool Handled,
        bool Execute,
        Guid TaskId,
        Guid? ExecutionId,
        string? ExternalExecutionId,
        bool CancellationRequested)
    {
        public static PrepareResult NotHandled { get; } = new(false, false, Guid.Empty, null, null, false);
    }

    public void Dispose() => processGate.Dispose();
}

public sealed class ResponsesWorkerOptions
{
    public const string SectionName = "ResponsesWorker";

    public bool Enabled { get; set; } = true;

    public int PollingIntervalMs { get; set; } = 250;

    public long LeaseDurationMs { get; set; } = 65_001;

}

public sealed partial class ResponsesWorkerHostedService(
    IServiceScopeFactory scopeFactory,
    IOptions<ResponsesWorkerOptions> options,
    ILogger<ResponsesWorkerHostedService> logger,
    IRuntimeStateObserver stateObserver) : BackgroundService
{
    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        stateObserver.SetWorker("Responses", "starting");
        if (!options.Value.Enabled)
        {
            stateObserver.SetWorker("Responses", "disabled");
            return;
        }

        stateObserver.SetWorker("Responses", "running");
        try
        {
            while (!stoppingToken.IsCancellationRequested)
            {
                try
                {
                    await using var scope = scopeFactory.CreateAsyncScope();
                    await scope.ServiceProvider.GetRequiredService<ResponsesWorker>().ProcessOneAsync(stoppingToken);
                    stateObserver.SetWorker("Responses", "running");
                }
                catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested)
                {
                    break;
                }
                catch (Exception exception)
                {
                    stateObserver.SetWorker("Responses", "faulted");
                    LogCycleFailed(logger, exception);
                }

                await Task.Delay(Math.Clamp(options.Value.PollingIntervalMs, 25, 60_000), stoppingToken);
            }
        }
        finally
        {
            stateObserver.SetWorker("Responses", "stopped");
        }
    }

    [LoggerMessage(EventId = 3301, Level = LogLevel.Error, Message = "Responses worker cycle failed.")]
    private static partial void LogCycleFailed(ILogger logger, Exception exception);
}
