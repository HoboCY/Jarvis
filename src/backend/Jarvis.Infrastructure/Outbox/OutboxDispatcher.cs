using System.Data;
using Jarvis.Application.Outbox;
using Jarvis.Domain.Outbox;
using Jarvis.Infrastructure.Data;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;

namespace Jarvis.Infrastructure.Outbox;

public sealed partial class OutboxDispatcher(
    IServiceScopeFactory scopeFactory,
    IOptions<OutboxOptions> options,
    ILogger<OutboxDispatcher> logger,
    TimeProvider timeProvider) : BackgroundService
{
    public async Task<int> ProcessOnceAsync(CancellationToken cancellationToken = default)
    {
        await using var scope = scopeFactory.CreateAsyncScope();
        var db = scope.ServiceProvider.GetRequiredService<JarvisDbContext>();
        var publisher = scope.ServiceProvider.GetRequiredService<IOutboxPublisher>();
        var nowMs = timeProvider.GetUtcNow().ToUnixTimeMilliseconds();
        var batchSize = Math.Clamp(options.Value.BatchSize, 1, 100);
        var leaseId = Guid.CreateVersion7();
        var leaseUntilMs = checked(nowMs + options.Value.LeaseDurationMs);
        List<OutboxMessage> messages;

        try
        {
            await using var transaction = await db.Database.BeginTransactionAsync(
                IsolationLevel.Serializable,
                cancellationToken);
            messages = await db.OutboxMessages
                .Where(message => message.PublishedAtMs == null
                    && (message.NextAttemptAtMs == null || message.NextAttemptAtMs <= nowMs)
                    && (message.ClaimedUntilMs == null || message.ClaimedUntilMs <= nowMs))
                .OrderBy(message => message.CreatedAtMs)
                .Take(batchSize)
                .ToListAsync(cancellationToken);

            foreach (var message in messages)
            {
                message.Claim(leaseId, leaseUntilMs);
            }

            await db.SaveChangesAsync(cancellationToken);
            await transaction.CommitAsync(cancellationToken);
        }
        catch (DbUpdateConcurrencyException)
        {
            db.ChangeTracker.Clear();
            return 0;
        }

        var processed = 0;
        foreach (var message in messages)
        {
            try
            {
                await publisher.PublishAsync(message, cancellationToken);
                message.MarkPublished(timeProvider.GetUtcNow().ToUnixTimeMilliseconds(), leaseId);
            }
            catch (Exception exception) when (exception is not OperationCanceledException)
            {
                var attempt = message.AttemptCount + 1;
                var backoffMs = Math.Min(
                    options.Value.MaxBackoffMs,
                    1_000 * (1L << Math.Min(attempt - 1, 6)));
                message.MarkFailed(
                    exception.Message,
                    timeProvider.GetUtcNow().ToUnixTimeMilliseconds() + backoffMs,
                    leaseId);
                LogOutboxFailure(logger, exception, message.Id, attempt);
            }

            await db.SaveChangesAsync(cancellationToken);
            processed++;
        }

        return processed;
    }

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
                await ProcessOnceAsync(stoppingToken);
            }
            catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested)
            {
                break;
            }
            catch (Exception exception)
            {
                LogDispatcherCycleFailure(logger, exception);
            }

            var delayMs = Math.Clamp(options.Value.PollingIntervalMs, 100, 60_000);
            await Task.Delay(delayMs, stoppingToken);
        }
    }

    [LoggerMessage(
        EventId = 1,
        Level = LogLevel.Warning,
        Message = "Outbox event {OutboxMessageId} failed on attempt {Attempt}.")]
    private static partial void LogOutboxFailure(
        ILogger logger,
        Exception exception,
        Guid outboxMessageId,
        int attempt);

    [LoggerMessage(
        EventId = 2,
        Level = LogLevel.Error,
        Message = "Outbox dispatcher cycle failed.")]
    private static partial void LogDispatcherCycleFailure(ILogger logger, Exception exception);
}
