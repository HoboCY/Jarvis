using System.Data;
using System.Text.Json;
using Jarvis.Application.Responses;
using Jarvis.Domain.Conversations;
using Jarvis.Domain.Outbox;
using Jarvis.Infrastructure.Data;
using Jarvis.Infrastructure.Realtime;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;

namespace Jarvis.Infrastructure.Summaries;

public sealed class SummaryWorker(
    JarvisDbContext db,
    ISummaryProvider provider,
    TimeProvider timeProvider,
    IOptions<OpenAiRealtimeOptions> openAiOptions,
    IOptions<SummaryWorkerOptions> options) : IDisposable
{
    private readonly SemaphoreSlim processGate = new(1, 1);

    public async Task<bool> ProcessOneAsync(CancellationToken cancellationToken = default)
    {
        var conversationIds = await db.Conversations
            .AsNoTracking()
            .OrderBy(conversation => conversation.LastActivityAtMs)
            .Take(100)
            .Select(conversation => conversation.Id)
            .ToListAsync(cancellationToken);
        foreach (var conversationId in conversationIds)
        {
            if (await LoadInputAsync(conversationId, cancellationToken) is not null)
            {
                return await ProcessOneAsync(conversationId, cancellationToken);
            }
        }

        return false;
    }

    public async Task<bool> ProcessOneAsync(Guid conversationId, CancellationToken cancellationToken = default)
    {
        ArgumentOutOfRangeException.ThrowIfEqual(conversationId, Guid.Empty);
        await processGate.WaitAsync(cancellationToken);
        try
        {
            var input = await LoadInputAsync(conversationId, cancellationToken);
            if (input is null)
            {
                return false;
            }

            string summaryText;
            try
            {
                summaryText = await provider.SummarizeAsync(input, cancellationToken);
            }
            catch (OperationCanceledException) when (!cancellationToken.IsCancellationRequested)
            {
                return false;
            }
            catch (Exception)
            {
                return false;
            }

            if (string.IsNullOrWhiteSpace(summaryText))
            {
                return false;
            }

            await using var transaction = await db.Database.BeginTransactionAsync(IsolationLevel.Serializable, cancellationToken);
            db.ChangeTracker.Clear();
            var conversation = await db.Conversations.SingleOrDefaultAsync(
                item => item.Id == conversationId,
                cancellationToken);
            if (conversation is null || conversation.CurrentSummaryId != input.CurrentSummaryId)
            {
                return false;
            }

            var committedInput = await LoadInputAsync(conversationId, cancellationToken);
            if (committedInput is null
                || committedInput.FromSequence != input.FromSequence
                || committedInput.ToSequence != input.ToSequence
                || committedInput.Messages.Count != input.Messages.Count
                || !string.Equals(committedInput.PreviousSummary, input.PreviousSummary, StringComparison.Ordinal))
            {
                return false;
            }

            var nowMs = timeProvider.GetUtcNow().ToUnixTimeMilliseconds();
            var summary = ConversationSummary.Create(
                Guid.CreateVersion7(),
                conversationId,
                input.FromSequence,
                input.ToSequence,
                summaryText,
                openAiOptions.Value.SummarizerModel,
                nowMs);
            db.ConversationSummaries.Add(summary);
            conversation.SetCurrentSummary(summary.Id);

            var eventId = Guid.CreateVersion7();
            db.OutboxMessages.Add(OutboxMessage.Create(
                eventId,
                "conversation.summaryUpdated",
                JsonSerializer.Serialize(new
                {
                    eventId,
                    occurredAt = nowMs,
                    type = "conversation.summaryUpdated",
                    payload = new
                    {
                        conversationId,
                        summaryId = summary.Id,
                        fromSequence = summary.FromSequence,
                        toSequence = summary.ToSequence,
                        entityVersion = conversation.Version
                    }
                }),
                nowMs));

            await db.SaveChangesAsync(cancellationToken);
            await transaction.CommitAsync(cancellationToken);
            return true;
        }
        finally
        {
            processGate.Release();
        }
    }

    private async Task<SummaryRequest?> LoadInputAsync(Guid conversationId, CancellationToken cancellationToken)
    {
        var conversation = await db.Conversations.AsNoTracking().SingleOrDefaultAsync(
            item => item.Id == conversationId,
            cancellationToken);
        if (conversation is null)
        {
            return null;
        }

        var currentSummary = conversation.CurrentSummaryId is Guid summaryId
            ? await db.ConversationSummaries.AsNoTracking().SingleOrDefaultAsync(
                item => item.Id == summaryId && item.ConversationId == conversationId,
                cancellationToken)
            : null;
        var lastSequence = currentSummary?.ToSequence ?? 0L;
        var messages = await db.Messages.AsNoTracking()
            .Where(message => message.ConversationId == conversationId && message.Sequence > lastSequence)
            .OrderBy(message => message.Sequence)
            .Take(500)
            .Select(message => new
            {
                message.Sequence,
                message.Role,
                message.Text,
                message.Status
            })
            .ToListAsync(cancellationToken);

        var contiguous = new List<SummaryInputMessage>();
        var expectedSequence = lastSequence + 1;
        foreach (var message in messages)
        {
            if (message.Sequence != expectedSequence)
            {
                break;
            }

            if (message.Status != MessageStatus.Completed || string.IsNullOrWhiteSpace(message.Text))
            {
                break;
            }

            contiguous.Add(new SummaryInputMessage(message.Role.ToString(), message.Text, message.Sequence));
            expectedSequence++;
        }

        return contiguous.Count < Math.Clamp(options.Value.MinimumMessageCount, 1, 500)
            ? null
            : new SummaryRequest(
                conversationId,
                currentSummary?.FromSequence ?? contiguous[0].Sequence,
                contiguous[^1].Sequence,
                contiguous,
                currentSummary?.Summary ?? string.Empty,
                conversation.CurrentSummaryId);
    }

    public void Dispose() => processGate.Dispose();
}

public sealed class SummaryWorkerOptions
{
    public const string SectionName = "SummaryWorker";

    public bool Enabled { get; set; } = true;

    public int PollingIntervalMs { get; set; } = 1_000;

    public int MinimumMessageCount { get; set; } = 4;
}

public sealed partial class SummaryWorkerHostedService(
    IServiceScopeFactory scopeFactory,
    IOptions<SummaryWorkerOptions> options,
    ILogger<SummaryWorkerHostedService> logger) : BackgroundService
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
                await scope.ServiceProvider.GetRequiredService<SummaryWorker>().ProcessOneAsync(stoppingToken);
            }
            catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested)
            {
                break;
            }
            catch (Exception exception)
            {
                LogCycleFailed(logger, exception);
            }

            await Task.Delay(Math.Clamp(options.Value.PollingIntervalMs, 100, 60_000), stoppingToken);
        }
    }

    [LoggerMessage(EventId = 3401, Level = LogLevel.Error, Message = "Summary worker cycle failed.")]
    private static partial void LogCycleFailed(ILogger logger, Exception exception);
}
