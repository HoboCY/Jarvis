using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using Jarvis.Contracts;
using Jarvis.Infrastructure.Data;
using Microsoft.AspNetCore.Hosting;
using Microsoft.EntityFrameworkCore;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Xunit;

namespace Jarvis.Api.IntegrationTests;

public sealed class PersistenceAndConfigurationTests
{
    [Fact]
    public async Task PersistenceUsesTheInjectedTimeProvider()
    {
        var now = new DateTimeOffset(2030, 1, 2, 3, 4, 5, TimeSpan.Zero);
        using var factory = new TestApplicationFactory(
            null,
            true,
            null,
            new FixedTimeProvider(now));
        using var client = CreateAuthenticatedClient(factory);

        using var request = new HttpRequestMessage(HttpMethod.Post, "/api/v1/conversations")
        {
            Content = JsonContent.Create(new CreateConversationRequest("fixed time"))
        };
        request.Headers.Add("Idempotency-Key", "fixed-time-create");
        var response = await client.SendAsync(request);
        var conversation = await response.Content.ReadFromJsonAsync<ConversationResponse>();

        Assert.Equal(HttpStatusCode.Created, response.StatusCode);
        Assert.NotNull(conversation);
        Assert.Equal(now.ToUnixTimeMilliseconds(), conversation.CreatedAtMs);
        Assert.Equal(now.ToUnixTimeMilliseconds(), conversation.LastActivityAtMs);
    }

    [Fact]
    public async Task IdempotencyRecordsUseTheConfiguredRetentionWindow()
    {
        var now = new DateTimeOffset(2030, 1, 2, 3, 4, 5, TimeSpan.Zero);
        var databasePath = Path.Combine(Path.GetTempPath(), $"jarvis-idempotency-expiry-{Guid.NewGuid():N}.db");
        using var factory = new TestApplicationFactory(
            databasePath,
            true,
            null,
            new FixedTimeProvider(now));
        using var client = CreateAuthenticatedClient(factory);
        using var request = new HttpRequestMessage(HttpMethod.Post, "/api/v1/conversations")
        {
            Content = JsonContent.Create(new CreateConversationRequest("expiry"))
        };
        request.Headers.Add("Idempotency-Key", "expiry-create");
        var response = await client.SendAsync(request);
        response.EnsureSuccessStatusCode();

        await using var scope = factory.Services.CreateAsyncScope();
        var db = scope.ServiceProvider.GetRequiredService<JarvisDbContext>();
        var record = Assert.Single(db.IdempotencyRecords);
        Assert.Equal(now.ToUnixTimeMilliseconds(), record.CreatedAtMs);
        Assert.Equal(
            now.AddHours(24).ToUnixTimeMilliseconds(),
            record.ExpiresAtMs);
    }

    [Fact]
    public async Task ExpiredCreateIdempotencyKeyCreatesANewConversation()
    {
        var now = new DateTimeOffset(2030, 1, 2, 3, 4, 5, TimeSpan.Zero);
        var clock = new AdvancingTimeProvider(now);
        using var factory = new TestApplicationFactory(null, true, null, clock);
        using var client = CreateAuthenticatedClient(factory);

        var first = await PostConversationAsync(client, "expiry-reuse", "first");
        Assert.Equal(HttpStatusCode.Created, first.StatusCode);
        var firstResponse = await first.Content.ReadFromJsonAsync<ConversationResponse>();
        first.Dispose();
        Assert.NotNull(firstResponse);

        clock.Advance(TimeSpan.FromHours(24));
        var second = await PostConversationAsync(client, "expiry-reuse", "second");
        Assert.Equal(HttpStatusCode.Created, second.StatusCode);
        var secondResponse = await second.Content.ReadFromJsonAsync<ConversationResponse>();
        second.Dispose();

        Assert.NotNull(secondResponse);
        Assert.NotEqual(firstResponse.Id, secondResponse.Id);

        await using var scope = factory.Services.CreateAsyncScope();
        var db = scope.ServiceProvider.GetRequiredService<JarvisDbContext>();
        Assert.Equal(2, await db.Conversations.CountAsync());
        Assert.Equal(1, await db.IdempotencyRecords.CountAsync(
            record => record.Scope == "conversations:create"
                && record.IdempotencyKey == "expiry-reuse"));
    }

    [Fact]
    public async Task ExpiredTypedIdempotencyKeyCanBeReusedButClientRequestIdRemainsUnique()
    {
        var now = new DateTimeOffset(2030, 1, 2, 3, 4, 5, TimeSpan.Zero);
        var clock = new AdvancingTimeProvider(now);
        using var factory = new TestApplicationFactory(null, true, null, clock);
        using var client = CreateAuthenticatedClient(factory);
        var conversation = await PostConversationAsync(client, "typed-expiry-create", "typed expiry");
        Assert.Equal(HttpStatusCode.Created, conversation.StatusCode);
        var conversationResponse = await conversation.Content.ReadFromJsonAsync<ConversationResponse>();
        conversation.Dispose();
        Assert.NotNull(conversationResponse);

        var first = await PostTypedMessageAsync(
            client,
            conversationResponse.Id,
            "typed-expiry",
            "client-one",
            "first");
        Assert.Equal(HttpStatusCode.OK, first.StatusCode);
        first.Dispose();

        clock.Advance(TimeSpan.FromHours(24));
        var second = await PostTypedMessageAsync(
            client,
            conversationResponse.Id,
            "typed-expiry",
            "client-two",
            "second");
        Assert.Equal(HttpStatusCode.OK, second.StatusCode);
        second.Dispose();

        clock.Advance(TimeSpan.FromHours(24));
        var clientRequestConflict = await PostTypedMessageAsync(
            client,
            conversationResponse.Id,
            "typed-expiry",
            "client-one",
            "changed");
        Assert.Equal(HttpStatusCode.Conflict, clientRequestConflict.StatusCode);
        clientRequestConflict.Dispose();

        await using var scope = factory.Services.CreateAsyncScope();
        var db = scope.ServiceProvider.GetRequiredService<JarvisDbContext>();
        Assert.Equal(2, await db.Messages.CountAsync(
            message => message.ConversationId == conversationResponse.Id));
    }

    [Fact]
    public async Task ConcurrentExpiredCreateKeyCreatesOneNewConversationAndReplaysIt()
    {
        var now = new DateTimeOffset(2030, 1, 2, 3, 4, 5, TimeSpan.Zero);
        var clock = new AdvancingTimeProvider(now);
        using var factory = new TestApplicationFactory(null, true, null, clock);
        using var client = CreateAuthenticatedClient(factory);

        var first = await PostConversationAsync(client, "concurrent-expiry", "initial");
        var initial = await first.Content.ReadFromJsonAsync<ConversationResponse>();
        first.Dispose();
        Assert.NotNull(initial);

        clock.Advance(TimeSpan.FromHours(24));
        async Task<HttpResponseMessage> SendExpiredReuseAsync()
        {
            return await PostConversationAsync(client, "concurrent-expiry", "new conversation");
        }

        var responses = await Task.WhenAll(SendExpiredReuseAsync(), SendExpiredReuseAsync());
        using var firstReuse = responses[0];
        using var secondReuse = responses[1];
        Assert.Equal(HttpStatusCode.Created, firstReuse.StatusCode);
        Assert.Equal(HttpStatusCode.Created, secondReuse.StatusCode);
        var firstReuseResponse = await firstReuse.Content.ReadFromJsonAsync<ConversationResponse>();
        var secondReuseResponse = await secondReuse.Content.ReadFromJsonAsync<ConversationResponse>();
        Assert.NotNull(firstReuseResponse);
        Assert.NotNull(secondReuseResponse);
        Assert.Equal(firstReuseResponse.Id, secondReuseResponse.Id);
        Assert.NotEqual(initial.Id, firstReuseResponse.Id);

        await using var scope = factory.Services.CreateAsyncScope();
        var db = scope.ServiceProvider.GetRequiredService<JarvisDbContext>();
        Assert.Equal(2, await db.Conversations.CountAsync());
        Assert.Equal(1, await db.IdempotencyRecords.CountAsync(
            record => record.Scope == "conversations:create"
                && record.IdempotencyKey == "concurrent-expiry"));
    }

    [Fact]
    public async Task ConversationAndMessageSurviveRebuildingHostWithSameSqliteFile()
    {
        var databasePath = Path.Combine(Path.GetTempPath(), $"jarvis-restart-{Guid.NewGuid():N}.db");
        Guid conversationId;
        Guid messageId;
        try
        {
            using (var firstFactory = new TestApplicationFactory(databasePath, false, null))
            using (var firstClient = CreateAuthenticatedClient(firstFactory))
            {
                using var createRequest = new HttpRequestMessage(HttpMethod.Post, "/api/v1/conversations")
                {
                    Content = JsonContent.Create(new CreateConversationRequest("restart"))
                };
                createRequest.Headers.Add("Idempotency-Key", "restart-create");
                var createResponse = await firstClient.SendAsync(createRequest);
                createResponse.EnsureSuccessStatusCode();
                conversationId = (await createResponse.Content.ReadFromJsonAsync<ConversationResponse>())!.Id;

                using var messageRequest = new HttpRequestMessage(
                    HttpMethod.Post,
                    $"/api/v1/conversations/{conversationId}/messages/typed")
                {
                    Content = JsonContent.Create(new TypedMessageRequest("restart-client", "retained"))
                };
                messageRequest.Headers.Add("Idempotency-Key", "restart-message");
                var messageResponse = await firstClient.SendAsync(messageRequest);
                messageResponse.EnsureSuccessStatusCode();
                messageId = (await messageResponse.Content.ReadFromJsonAsync<TypedMessageResponse>())!.MessageId;
            }

            using var secondFactory = new TestApplicationFactory(databasePath, true, null);
            using var secondClient = CreateAuthenticatedClient(secondFactory);
            var detail = await secondClient.GetFromJsonAsync<ConversationResponse>(
                $"/api/v1/conversations/{conversationId}");
            Assert.NotNull(detail);
            Assert.Equal(messageId, Assert.Single(detail.Messages).Id);
            Assert.Equal("retained", detail.Messages[0].Text);
        }
        finally
        {
            foreach (var path in new[] { databasePath, $"{databasePath}-wal", $"{databasePath}-shm" })
            {
                if (File.Exists(path))
                {
                    File.Delete(path);
                }
            }
        }
    }

    [Theory]
    [InlineData("")]
    [InlineData("too-short")]
    public void MissingOrShortBearerTokenFailsHostStartup(string token)
    {
        using var factory = new InvalidTokenFactory(token);

        var exception = Assert.ThrowsAny<Exception>(() => factory.CreateClient());

        Assert.Contains("BearerToken", exception.ToString(), StringComparison.Ordinal);
        if (token.Length > 0)
        {
            Assert.DoesNotContain(token, exception.ToString(), StringComparison.Ordinal);
        }
    }

    private static HttpClient CreateAuthenticatedClient(TestApplicationFactory factory)
    {
        var client = factory.CreateClient();
        client.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", factory.Token);
        return client;
    }

    private static async Task<HttpResponseMessage> PostConversationAsync(
        HttpClient client,
        string idempotencyKey,
        string title)
    {
        using var request = new HttpRequestMessage(HttpMethod.Post, "/api/v1/conversations")
        {
            Content = JsonContent.Create(new CreateConversationRequest(title))
        };
        request.Headers.Add("Idempotency-Key", idempotencyKey);
        return await client.SendAsync(request);
    }

    private static async Task<HttpResponseMessage> PostTypedMessageAsync(
        HttpClient client,
        Guid conversationId,
        string idempotencyKey,
        string clientRequestId,
        string text)
    {
        using var request = new HttpRequestMessage(
            HttpMethod.Post,
            $"/api/v1/conversations/{conversationId}/messages/typed")
        {
            Content = JsonContent.Create(new TypedMessageRequest(clientRequestId, text))
        };
        request.Headers.Add("Idempotency-Key", idempotencyKey);
        return await client.SendAsync(request);
    }

    private sealed class InvalidTokenFactory(string token) : WebApplicationFactory<Program>
    {
        private readonly string _databasePath = Path.Combine(
            Path.GetTempPath(),
            $"jarvis-invalid-token-{Guid.NewGuid():N}.db");

        protected override void ConfigureWebHost(IWebHostBuilder builder)
        {
            builder.UseEnvironment("Testing");
            builder.ConfigureAppConfiguration((_, configuration) => configuration.AddInMemoryCollection(
                new Dictionary<string, string?>
                {
                    ["Authentication:BearerToken"] = token,
                    ["ConnectionStrings:Jarvis"] = $"Data Source={_databasePath}",
                    ["Outbox:Enabled"] = "false"
                }));
        }

        protected override void Dispose(bool disposing)
        {
            base.Dispose(disposing);
            if (disposing)
            {
                foreach (var path in new[] { _databasePath, $"{_databasePath}-wal", $"{_databasePath}-shm" })
                {
                    if (File.Exists(path))
                    {
                        File.Delete(path);
                    }
                }
            }
        }
    }

    private sealed class FixedTimeProvider(DateTimeOffset now) : TimeProvider
    {
        public override DateTimeOffset GetUtcNow() => now;
    }

    private sealed class AdvancingTimeProvider(DateTimeOffset initial) : TimeProvider
    {
        private DateTimeOffset _now = initial;

        public override DateTimeOffset GetUtcNow() => _now;

        public void Advance(TimeSpan duration) => _now += duration;
    }
}
