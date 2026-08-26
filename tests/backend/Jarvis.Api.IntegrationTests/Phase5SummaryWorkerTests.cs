using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Text.Json;
using Jarvis.Application.Responses;
using Jarvis.Infrastructure.Data;
using Jarvis.Infrastructure.Summaries;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Xunit;

namespace Jarvis.Api.IntegrationTests;

public sealed class Phase5SummaryWorkerTests
{
    [Fact]
    public async Task SummaryWorkerPersistsAContinuousRangeAndPublishesAnOutboxEvent()
    {
        var provider = new ScriptedSummaryProvider("摘要：用户讨论了测试。");
        using var factory = CreateFactory(provider);
        using var client = factory.CreateClient();
        client.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", factory.Token);
        var conversationId = await CreateConversationAsync(client);
        await AddMessageAsync(client, conversationId, "第一条", "summary-message-1");
        await AddMessageAsync(client, conversationId, "第二条", "summary-message-2");

        await using var scope = factory.Services.CreateAsyncScope();
        var worker = scope.ServiceProvider.GetRequiredService<SummaryWorker>();
        Assert.True(await worker.ProcessOneAsync(conversationId));

        var db = scope.ServiceProvider.GetRequiredService<JarvisDbContext>();
        var conversation = await db.Conversations.SingleAsync(item => item.Id == conversationId);
        var summary = await db.ConversationSummaries.SingleAsync(item => item.Id == conversation.CurrentSummaryId);
        Assert.Equal(1, summary.FromSequence);
        Assert.Equal(2, summary.ToSequence);
        Assert.Equal("摘要：用户讨论了测试。", summary.Summary);
        Assert.Contains(
            await db.OutboxMessages.Where(item => item.EventType == "conversation.summaryUpdated").ToListAsync(),
            item => item.PayloadJson.Contains(summary.Id.ToString(), StringComparison.Ordinal));
        Assert.Equal(1, provider.Calls);
    }

    [Fact]
    public async Task ProviderFailureLeavesMessagesAndCurrentSummaryUntouched()
    {
        var provider = new ScriptedSummaryProvider(null, new InvalidOperationException("provider unavailable"));
        using var factory = CreateFactory(provider);
        using var client = factory.CreateClient();
        client.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", factory.Token);
        var conversationId = await CreateConversationAsync(client);
        await AddMessageAsync(client, conversationId, "不会被改写", "summary-failure-message");

        await using var scope = factory.Services.CreateAsyncScope();
        var db = scope.ServiceProvider.GetRequiredService<JarvisDbContext>();
        var beforeMessages = await db.Messages
            .Where(item => item.ConversationId == conversationId)
            .Select(item => new { item.Id, item.Text, item.Status, item.Version })
            .ToListAsync();
        var worker = scope.ServiceProvider.GetRequiredService<SummaryWorker>();
        Assert.False(await worker.ProcessOneAsync(conversationId));

        db.ChangeTracker.Clear();
        var conversation = await db.Conversations.SingleAsync(item => item.Id == conversationId);
        Assert.Null(conversation.CurrentSummaryId);
        Assert.Equal(0, await db.ConversationSummaries.CountAsync(item => item.ConversationId == conversationId));
        var afterMessages = await db.Messages
            .Where(item => item.ConversationId == conversationId)
            .Select(item => new { item.Id, item.Text, item.Status, item.Version })
            .ToListAsync();
        Assert.Equal(beforeMessages, afterMessages);
    }

    [Fact]
    public async Task ALaterSummaryAccumulatesThePreviousSummaryAndUsesTheFullRange()
    {
        var provider = new RecordingSummaryProvider("旧事实摘要", "旧事实摘要；新增事实");
        using var factory = CreateFactory(provider);
        using var client = factory.CreateClient();
        client.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", factory.Token);
        var conversationId = await CreateConversationAsync(client);
        await AddMessageAsync(client, conversationId, "第一条", "summary-accumulate-1");
        await AddMessageAsync(client, conversationId, "第二条", "summary-accumulate-2");

        await using (var firstScope = factory.Services.CreateAsyncScope())
        {
            Assert.True(await firstScope.ServiceProvider.GetRequiredService<SummaryWorker>().ProcessOneAsync(conversationId));
        }

        await AddMessageAsync(client, conversationId, "第三条", "summary-accumulate-3");
        await AddMessageAsync(client, conversationId, "第四条", "summary-accumulate-4");
        await using (var secondScope = factory.Services.CreateAsyncScope())
        {
            Assert.True(await secondScope.ServiceProvider.GetRequiredService<SummaryWorker>().ProcessOneAsync(conversationId));
        }

        await using var verificationScope = factory.Services.CreateAsyncScope();
        var db = verificationScope.ServiceProvider.GetRequiredService<JarvisDbContext>();
        var conversation = await db.Conversations.SingleAsync(item => item.Id == conversationId);
        var summary = await db.ConversationSummaries.SingleAsync(item => item.Id == conversation.CurrentSummaryId);
        Assert.Equal(1, summary.FromSequence);
        Assert.Equal(4, summary.ToSequence);
        Assert.Equal("旧事实摘要；新增事实", summary.Summary);
        Assert.Equal("旧事实摘要", provider.Requests[1].PreviousSummary);
        Assert.Equal(1, provider.Requests[1].FromSequence);
        Assert.Equal(4, provider.Requests[1].ToSequence);
        Assert.Equal(new long[] { 3, 4 }, provider.Requests[1].Messages.Select(message => message.Sequence));
    }

    private static TestApplicationFactory CreateFactory(ISummaryProvider provider) =>
        new(
            null,
            true,
            null,
            null,
            null,
            null,
            null,
            null,
            null,
            provider);

    private static async Task<Guid> CreateConversationAsync(HttpClient client)
    {
        using var request = new HttpRequestMessage(HttpMethod.Post, "/api/v1/conversations")
        {
            Content = JsonContent.Create(new { title = "summary" })
        };
        request.Headers.Add("Idempotency-Key", $"summary-conversation-{Guid.CreateVersion7():N}");
        using var response = await client.SendAsync(request);
        response.EnsureSuccessStatusCode();
        return (await response.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("id").GetGuid();
    }

    private static async Task AddMessageAsync(HttpClient client, Guid conversationId, string text, string clientRequestId)
    {
        using var request = new HttpRequestMessage(HttpMethod.Post, $"/api/v1/conversations/{conversationId}/messages/typed")
        {
            Content = JsonContent.Create(new { clientRequestId, text })
        };
        request.Headers.Add("Idempotency-Key", $"summary-{clientRequestId}");
        using var response = await client.SendAsync(request);
        response.EnsureSuccessStatusCode();
    }

    private sealed class ScriptedSummaryProvider(string? summary, Exception? failure = null) : ISummaryProvider
    {
        public int Calls { get; private set; }

        public Task<string> SummarizeAsync(SummaryRequest request, CancellationToken cancellationToken)
        {
            Calls++;
            if (failure is not null)
            {
                throw failure;
            }

            return Task.FromResult(summary!);
        }
    }

    private sealed class RecordingSummaryProvider(params string[] summaries) : ISummaryProvider
    {
        public List<SummaryRequest> Requests { get; } = [];

        public Task<string> SummarizeAsync(SummaryRequest request, CancellationToken cancellationToken)
        {
            Requests.Add(request);
            return Task.FromResult(summaries[Requests.Count - 1]);
        }
    }
}
