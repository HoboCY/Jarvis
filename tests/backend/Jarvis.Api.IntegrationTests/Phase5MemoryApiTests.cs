using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Text.Json;
using Jarvis.Domain.Conversations;
using Jarvis.Domain.Identity;
using Jarvis.Domain.Memory;
using Jarvis.Infrastructure.Data;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Xunit;

namespace Jarvis.Api.IntegrationTests;

public sealed class Phase5MemoryApiTests : IClassFixture<TestApplicationFactory>
{
    private readonly TestApplicationFactory factory;

    public Phase5MemoryApiTests(TestApplicationFactory factory)
    {
        this.factory = factory;
    }

    [Fact]
    public async Task ExplicitMemoryCanBeSavedSupersededAndRetractedThroughAuthenticatedApi()
    {
        using var client = factory.CreateClient();
        client.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", factory.Token);
        var conversationId = await CreateConversationAsync(client);
        var sourceMessageId = await AddMessageAsync(client, conversationId, "请记住我喜欢简洁回答");

        using var save = new HttpRequestMessage(HttpMethod.Post, "/api/v1/memory-facts")
        {
            Content = JsonContent.Create(new
            {
                key = "communication.responseLength",
                value = "prefer concise answers",
                sourceMessageId,
                sensitive = false
            })
        };
        save.Headers.Add("Idempotency-Key", "memory-save-one");
        using var saved = await client.SendAsync(save);
        Assert.Equal(System.Net.HttpStatusCode.OK, saved.StatusCode);
        var savedJson = await saved.Content.ReadFromJsonAsync<JsonElement>();
        Assert.True(savedJson.GetProperty("saved").GetBoolean());
        var firstMemoryId = savedJson.GetProperty("memoryId").GetGuid();

        using var replay = new HttpRequestMessage(HttpMethod.Post, "/api/v1/memory-facts")
        {
            Content = JsonContent.Create(new
            {
                key = "communication.responseLength",
                value = "prefer concise answers",
                sourceMessageId,
                sensitive = false
            })
        };
        replay.Headers.Add("Idempotency-Key", "memory-save-one");
        using var replayed = await client.SendAsync(replay);
        Assert.Equal(System.Net.HttpStatusCode.OK, replayed.StatusCode);
        Assert.Equal(firstMemoryId, (await replayed.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("memoryId").GetGuid());

        var secondSourceMessageId = await AddMessageAsync(client, conversationId, "remember that I prefer detailed answers");
        using var supersede = new HttpRequestMessage(HttpMethod.Post, "/api/v1/memory-facts")
        {
            Content = JsonContent.Create(new
            {
                key = "communication.responseLength",
                value = "prefer detailed answers",
                sourceMessageId = secondSourceMessageId,
                sensitive = false
            })
        };
        supersede.Headers.Add("Idempotency-Key", "memory-save-two");
        using var superseded = await client.SendAsync(supersede);
        Assert.Equal(System.Net.HttpStatusCode.OK, superseded.StatusCode);
        var secondMemoryId = (await superseded.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("memoryId").GetGuid();

        await using (var scope = factory.Services.CreateAsyncScope())
        {
            var db = scope.ServiceProvider.GetRequiredService<JarvisDbContext>();
            var facts = await db.MemoryFacts.AsNoTracking().Where(fact => fact.Key == "communication.responseLength").ToListAsync();
            Assert.Equal(2, facts.Count);
            Assert.Equal(Jarvis.Domain.Memory.MemoryFactStatus.Retracted, facts.Single(fact => fact.Id == firstMemoryId).Status);
            Assert.Equal(firstMemoryId, facts.Single(fact => fact.Id == secondMemoryId).SupersedesMemoryId);
        }

        using var retract = new HttpRequestMessage(HttpMethod.Post, $"/api/v1/memory-facts/{secondMemoryId}/retract");
        retract.Headers.Add("Idempotency-Key", "memory-retract-two");
        using var retracted = await client.SendAsync(retract);
        Assert.Equal(System.Net.HttpStatusCode.OK, retracted.StatusCode);
        Assert.True((await retracted.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("retracted").GetBoolean());
    }

    [Fact]
    public async Task NonExplicitAndForeignSourceMessagesAreRejected()
    {
        using var client = factory.CreateClient();
        client.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", factory.Token);
        var ownedConversationId = await CreateConversationAsync(client);
        var nonExplicitSourceId = await AddMessageAsync(client, ownedConversationId, "我喜欢简洁回答");

        using var nonExplicit = CreateSaveRequest(
            "memory-non-explicit",
            "nonExplicit",
            "should fail",
            nonExplicitSourceId);
        using var nonExplicitResponse = await client.SendAsync(nonExplicit);
        Assert.Equal(System.Net.HttpStatusCode.BadRequest, nonExplicitResponse.StatusCode);

        Guid foreignSourceId;
        await using (var scope = factory.Services.CreateAsyncScope())
        {
            var db = scope.ServiceProvider.GetRequiredService<JarvisDbContext>();
            var nowMs = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
            var foreignUserId = Guid.CreateVersion7();
            var foreignConversationId = Guid.CreateVersion7();
            db.Users.Add(User.Create(foreignUserId, "Foreign", "en-US", "UTC", nowMs));
            db.Conversations.Add(Conversation.Create(foreignConversationId, foreignUserId, "Foreign conversation", nowMs));
            foreignSourceId = Guid.CreateVersion7();
            db.Messages.Add(Message.CreateTypedUserMessage(
                foreignSourceId,
                foreignConversationId,
                "remember this foreign fact",
                "foreign-source",
                1,
                nowMs));
            await db.SaveChangesAsync();
        }

        using var foreign = CreateSaveRequest(
            "memory-foreign-source",
            "foreign",
            "must fail",
            foreignSourceId);
        using var foreignResponse = await client.SendAsync(foreign);
        Assert.Equal(System.Net.HttpStatusCode.BadRequest, foreignResponse.StatusCode);
    }

    [Fact]
    public async Task SensitiveFactsAreDeniedByDefaultAndUnauthenticatedRequestsAreRejected()
    {
        using var client = factory.CreateClient();
        client.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", factory.Token);
        var conversationId = await CreateConversationAsync(client);
        var sourceMessageId = await AddMessageAsync(client, conversationId, "请记住这是敏感事实");
        using var sensitive = CreateSaveRequest("memory-sensitive", "secret", "must fail", sourceMessageId, sensitive: true);
        using var sensitiveResponse = await client.SendAsync(sensitive);
        Assert.Equal(System.Net.HttpStatusCode.BadRequest, sensitiveResponse.StatusCode);

        using var anonymous = factory.CreateClient();
        using var unauthenticated = CreateSaveRequest("memory-anonymous", "anonymous", "must fail", sourceMessageId);
        using var unauthenticatedResponse = await anonymous.SendAsync(unauthenticated);
        Assert.Equal(System.Net.HttpStatusCode.Unauthorized, unauthenticatedResponse.StatusCode);
    }

    [Fact]
    public async Task RetractingAnotherUsersFactReturnsNotFoundWithoutChangingIt()
    {
        using var client = factory.CreateClient();
        client.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", factory.Token);
        Guid foreignFactId;
        await using (var scope = factory.Services.CreateAsyncScope())
        {
            var db = scope.ServiceProvider.GetRequiredService<JarvisDbContext>();
            var foreignUserId = Guid.CreateVersion7();
            var nowMs = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
            db.Users.Add(User.Create(foreignUserId, "Foreign fact owner", "en-US", "UTC", nowMs));
            foreignFactId = Guid.CreateVersion7();
            db.MemoryFacts.Add(MemoryFact.CreateDirect(
                foreignFactId,
                foreignUserId,
                "foreign.key",
                JsonSerializer.Serialize("private"),
                null,
                sensitive: false,
                nowMs));
            await db.SaveChangesAsync();
        }

        using var retract = new HttpRequestMessage(HttpMethod.Post, $"/api/v1/memory-facts/{foreignFactId}/retract");
        retract.Headers.Add("Idempotency-Key", "memory-foreign-retract");
        using var response = await client.SendAsync(retract);
        Assert.Equal(System.Net.HttpStatusCode.NotFound, response.StatusCode);

        await using var verificationScope = factory.Services.CreateAsyncScope();
        var persisted = await verificationScope.ServiceProvider.GetRequiredService<JarvisDbContext>().MemoryFacts
            .AsNoTracking()
            .SingleAsync(item => item.Id == foreignFactId);
        Assert.Equal(MemoryFactStatus.Active, persisted.Status);
    }

    [Fact]
    public async Task ConcurrentWritesForOneUserAndKeyLeaveOneActiveFactWithoutServerErrors()
    {
        using var isolatedFactory = new TestApplicationFactory(null, true, null);
        using var client = isolatedFactory.CreateClient();
        client.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", isolatedFactory.Token);
        var conversationId = await CreateConversationAsync(client);
        var sourceMessageId = await AddMessageAsync(client, conversationId, "请记住我的回答风格");

        var responses = await Task.WhenAll(Enumerable.Range(0, 8).Select(async index =>
        {
            using var request = CreateSaveRequest(
                $"memory-concurrent-{index}",
                "concurrent.key",
                $"value-{index}",
                sourceMessageId);
            return await client.SendAsync(request);
        }));
        var responseDetails = await Task.WhenAll(responses.Select(async response =>
            (response.StatusCode, Body: await response.Content.ReadAsStringAsync())));
        Assert.All(responseDetails, detail =>
        {
            Assert.NotEqual(System.Net.HttpStatusCode.InternalServerError, detail.StatusCode);
            Assert.DoesNotContain("SQLite", detail.Body, StringComparison.OrdinalIgnoreCase);
            Assert.DoesNotContain("UNIQUE", detail.Body, StringComparison.OrdinalIgnoreCase);
        });
        foreach (var response in responses)
        {
            response.Dispose();
        }

        await using var verificationScope = isolatedFactory.Services.CreateAsyncScope();
        var db = verificationScope.ServiceProvider.GetRequiredService<JarvisDbContext>();
        Assert.Equal(
            1,
            await db.MemoryFacts.CountAsync(item => item.UserId != Guid.Empty
                && item.Key == "concurrent.key"
                && item.Status == MemoryFactStatus.Active));
    }

    private static HttpRequestMessage CreateSaveRequest(
        string idempotencyKey,
        string key,
        string value,
        Guid sourceMessageId,
        bool sensitive = false)
    {
        var request = new HttpRequestMessage(HttpMethod.Post, "/api/v1/memory-facts")
        {
            Content = JsonContent.Create(new
            {
                key,
                value,
                sourceMessageId,
                sensitive
            })
        };
        request.Headers.Add("Idempotency-Key", idempotencyKey);
        return request;
    }

    private static async Task<Guid> CreateConversationAsync(HttpClient client)
    {
        using var request = new HttpRequestMessage(HttpMethod.Post, "/api/v1/conversations")
        {
            Content = JsonContent.Create(new { title = "memory" })
        };
        request.Headers.Add("Idempotency-Key", $"memory-conversation-{Guid.CreateVersion7():N}");
        using var response = await client.SendAsync(request);
        response.EnsureSuccessStatusCode();
        return (await response.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("id").GetGuid();
    }

    private static async Task<Guid> AddMessageAsync(HttpClient client, Guid conversationId, string text)
    {
        using var request = new HttpRequestMessage(HttpMethod.Post, $"/api/v1/conversations/{conversationId}/messages/typed")
        {
            Content = JsonContent.Create(new
            {
                clientRequestId = $"memory-message-{Guid.CreateVersion7():N}",
                text,
                replyMode = "text"
            })
        };
        request.Headers.Add("Idempotency-Key", $"memory-message-{Guid.CreateVersion7():N}");
        using var response = await client.SendAsync(request);
        response.EnsureSuccessStatusCode();
        return (await response.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("messageId").GetGuid();
    }
}
