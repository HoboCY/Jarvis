using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Data.Common;
using System.Text.Json;
using Jarvis.Contracts;
using Jarvis.Infrastructure.Data;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Diagnostics;
using Microsoft.Extensions.DependencyInjection;
using Xunit;

namespace Jarvis.Api.IntegrationTests;

public sealed class ConversationApiTests : IClassFixture<TestApplicationFactory>
{
    private readonly TestApplicationFactory _factory;

    public ConversationApiTests(TestApplicationFactory factory)
    {
        _factory = factory;
    }

    [Fact]
    public async Task AuthenticatedUserCanCreateReadAndPageConversationMessages()
    {
        using var client = CreateAuthenticatedClient();
        var conversation = await CreateConversationAsync(client, "Paging");

        var first = await AddTypedMessageAsync(client, conversation.Id, "client-page-1", "first", "idem-page-1");
        var second = await AddTypedMessageAsync(client, conversation.Id, "client-page-2", "second", "idem-page-2");

        var detail = await client.GetFromJsonAsync<ConversationResponse>(
            $"/api/v1/conversations/{conversation.Id}");
        Assert.NotNull(detail);
        Assert.Equal(2, detail.MessageCount);
        Assert.Equal(new[] { first.MessageId, second.MessageId }, detail.Messages.Select(message => message.Id));

        var firstPage = await client.GetFromJsonAsync<MessagePageResponse>(
            $"/api/v1/conversations/{conversation.Id}/messages?limit=1");
        Assert.NotNull(firstPage);
        Assert.Single(firstPage.Items);
        Assert.Equal(second.MessageId, firstPage.Items[0].Id);
        Assert.NotNull(firstPage.NextCursor);

        var secondPage = await client.GetFromJsonAsync<MessagePageResponse>(
            $"/api/v1/conversations/{conversation.Id}/messages?cursor={firstPage.NextCursor}&limit=1");
        Assert.NotNull(secondPage);
        Assert.Single(secondPage.Items);
        Assert.Equal(first.MessageId, secondPage.Items[0].Id);
        Assert.Null(secondPage.NextCursor);
    }

    [Fact]
    public async Task ConversationJsonUsesCamelCaseEnumValues()
    {
        using var client = CreateAuthenticatedClient();
        var conversation = await CreateConversationAsync(client, "Enum values");
        await AddTypedMessageAsync(client, conversation.Id, "enum-client", "enum", "enum-idem");

        using var document = JsonDocument.Parse(
            await client.GetStringAsync($"/api/v1/conversations/{conversation.Id}"));
        var root = document.RootElement;
        Assert.Equal("active", root.GetProperty("status").GetString());
        var message = root.GetProperty("messages")[0];
        Assert.Equal("user", message.GetProperty("role").GetString());
        Assert.Equal("typedText", message.GetProperty("inputModality").GetString());
        Assert.Equal("completed", message.GetProperty("status").GetString());
    }

    [Fact]
    public async Task TypedMessageReplayReturnsOriginalIdentityAndConflictDoesNotAddMessage()
    {
        using var client = CreateAuthenticatedClient();
        var conversation = await CreateConversationAsync(client, "Idempotency");

        var first = await AddTypedMessageAsync(client, conversation.Id, "client-replay", "same", "idem-replay");
        var replay = await AddTypedMessageAsync(client, conversation.Id, "client-replay", "same", "idem-replay");
        Assert.Equal(first, replay);

        using var conflictRequest = new HttpRequestMessage(
            HttpMethod.Post,
            $"/api/v1/conversations/{conversation.Id}/messages/typed")
        {
            Content = JsonContent.Create(new TypedMessageRequest("client-replay", "different"))
        };
        conflictRequest.Headers.Add("Idempotency-Key", "idem-replay");
        var conflict = await client.SendAsync(conflictRequest);
        Assert.Equal(HttpStatusCode.Conflict, conflict.StatusCode);
        Assert.Equal("application/problem+json", conflict.Content.Headers.ContentType?.MediaType);

        var detail = await client.GetFromJsonAsync<ConversationResponse>(
            $"/api/v1/conversations/{conversation.Id}");
        Assert.NotNull(detail);
        Assert.Equal(1, detail.MessageCount);
    }

    [Fact]
    public async Task ConcurrentTypedRequestsWithSameKeyReturnOnePersistedMessage()
    {
        using var client = CreateAuthenticatedClient();
        var conversation = await CreateConversationAsync(client, "Concurrent");

        async Task<HttpResponseMessage> SendAsync()
        {
            var request = new HttpRequestMessage(
                HttpMethod.Post,
                $"/api/v1/conversations/{conversation.Id}/messages/typed")
            {
                Content = JsonContent.Create(new TypedMessageRequest("client-concurrent", "once"))
            };
            request.Headers.Add("Idempotency-Key", "idem-concurrent");
            return await client.SendAsync(request);
        }

        var responses = await Task.WhenAll(SendAsync(), SendAsync());
        using var first = responses[0];
        using var second = responses[1];
        Assert.Contains(first.StatusCode, new[] { HttpStatusCode.OK, HttpStatusCode.Created });
        Assert.Equal(HttpStatusCode.OK, second.StatusCode);

        var firstResult = await first.Content.ReadFromJsonAsync<TypedMessageResponse>();
        var secondResult = await second.Content.ReadFromJsonAsync<TypedMessageResponse>();
        Assert.NotNull(firstResult);
        Assert.NotNull(secondResult);
        Assert.Equal(firstResult.MessageId, secondResult.MessageId);
    }

    [Fact]
    public async Task ConcurrentCreateRequestsReplayFromTheDatabaseAfterAControlledReadRace()
    {
        var gate = new IdempotencyReadGate();
        var databasePath = Path.Combine(Path.GetTempPath(), $"jarvis-create-race-{Guid.NewGuid():N}.db");
        using var factory = new TestApplicationFactory(databasePath, true, null, null, gate);
        using var client = CreateAuthenticatedClient(factory);

        async Task<HttpResponseMessage> SendAsync()
        {
            using var request = new HttpRequestMessage(HttpMethod.Post, "/api/v1/conversations")
            {
                Content = JsonContent.Create(new CreateConversationRequest("race"))
            };
            request.Headers.Add("Idempotency-Key", "race-create");
            return await client.SendAsync(request);
        }

        var firstRequest = SendAsync();
        var secondRequest = SendAsync();
        try
        {
            await gate.TwoReadsReached.WaitAsync(TimeSpan.FromSeconds(5));
        }
        catch (TimeoutException exception)
        {
            gate.Release();
            throw new Xunit.Sdk.XunitException($"Idempotency reads reached: {gate.ReadCount}", exception);
        }
        gate.Release();

        using var first = await firstRequest;
        using var second = await secondRequest;
        Assert.Equal(HttpStatusCode.Created, first.StatusCode);
        Assert.Equal(HttpStatusCode.Created, second.StatusCode);
        var firstResult = await first.Content.ReadFromJsonAsync<ConversationResponse>();
        var secondResult = await second.Content.ReadFromJsonAsync<ConversationResponse>();
        Assert.NotNull(firstResult);
        Assert.NotNull(secondResult);
        Assert.Equal(firstResult.Id, secondResult.Id);
        Assert.True(gate.ReadCount >= 2, $"Expected two initial concurrent reads, got {gate.ReadCount}.");
        await using (var scope = factory.Services.CreateAsyncScope())
        {
            var db = scope.ServiceProvider.GetRequiredService<JarvisDbContext>();
            Assert.Equal(1, await db.Conversations.CountAsync());
            Assert.Equal(1, await db.IdempotencyRecords.CountAsync(
                record => record.Scope == "conversations:create" && record.IdempotencyKey == "race-create"));
        }
    }

    [Fact]
    public async Task ConcurrentCreateDifferentPayloadsConflictAfterAControlledReadRace()
    {
        var gate = new IdempotencyReadGate();
        var databasePath = Path.Combine(Path.GetTempPath(), $"jarvis-create-conflict-race-{Guid.NewGuid():N}.db");
        using var factory = new TestApplicationFactory(databasePath, true, null, null, gate);
        using var client = CreateAuthenticatedClient(factory);

        async Task<HttpResponseMessage> SendAsync(string title)
        {
            using var request = new HttpRequestMessage(HttpMethod.Post, "/api/v1/conversations")
            {
                Content = JsonContent.Create(new CreateConversationRequest(title))
            };
            request.Headers.Add("Idempotency-Key", "race-create-conflict");
            return await client.SendAsync(request);
        }

        var firstRequest = SendAsync("first");
        var secondRequest = SendAsync("second");
        try
        {
            await gate.TwoReadsReached.WaitAsync(TimeSpan.FromSeconds(5));
        }
        catch (TimeoutException exception)
        {
            gate.Release();
            throw new Xunit.Sdk.XunitException($"Idempotency reads reached: {gate.ReadCount}", exception);
        }
        gate.Release();

        using var first = await firstRequest;
        using var second = await secondRequest;
        var statuses = new[] { first.StatusCode, second.StatusCode };
        Assert.Contains(HttpStatusCode.Created, statuses);
        Assert.Contains(HttpStatusCode.Conflict, statuses);
        await using var scope = factory.Services.CreateAsyncScope();
        var db = scope.ServiceProvider.GetRequiredService<JarvisDbContext>();
        Assert.Equal(1, await db.Conversations.CountAsync());
        Assert.Equal(1, await db.IdempotencyRecords.CountAsync(
            record => record.Scope == "conversations:create"
                && record.IdempotencyKey == "race-create-conflict"));
    }

    [Fact]
    public async Task ConcurrentTypedRequestsReplayFromTheDatabaseAfterAControlledReadRace()
    {
        var databasePath = Path.Combine(Path.GetTempPath(), $"jarvis-typed-race-{Guid.NewGuid():N}.db");
        Guid conversationId;
        using (var setupFactory = new TestApplicationFactory(databasePath, false, null))
        using (var setupClient = CreateAuthenticatedClient(setupFactory))
        {
            conversationId = (await CreateConversationAsync(setupClient, "typed race")).Id;
        }

        var gate = new IdempotencyReadGate();
        using var factory = new TestApplicationFactory(databasePath, true, null, null, gate);
        using var client = CreateAuthenticatedClient(factory);

        async Task<HttpResponseMessage> SendAsync()
        {
            using var request = new HttpRequestMessage(
                HttpMethod.Post,
                $"/api/v1/conversations/{conversationId}/messages/typed")
            {
                Content = JsonContent.Create(new TypedMessageRequest("race-client", "race"))
            };
            request.Headers.Add("Idempotency-Key", "race-typed");
            return await client.SendAsync(request);
        }

        var firstRequest = SendAsync();
        var secondRequest = SendAsync();
        try
        {
            await gate.TwoReadsReached.WaitAsync(TimeSpan.FromSeconds(5));
        }
        catch (TimeoutException exception)
        {
            gate.Release();
            throw new Xunit.Sdk.XunitException($"Idempotency reads reached: {gate.ReadCount}", exception);
        }
        gate.Release();

        using var first = await firstRequest;
        using var second = await secondRequest;
        Assert.Equal(HttpStatusCode.OK, first.StatusCode);
        Assert.Equal(HttpStatusCode.OK, second.StatusCode);
        var firstResult = await first.Content.ReadFromJsonAsync<TypedMessageResponse>();
        var secondResult = await second.Content.ReadFromJsonAsync<TypedMessageResponse>();
        Assert.NotNull(firstResult);
        Assert.NotNull(secondResult);
        Assert.Equal(firstResult.MessageId, secondResult.MessageId);
        Assert.Equal(firstResult.Sequence, secondResult.Sequence);
        Assert.True(gate.ReadCount >= 2, $"Expected two initial concurrent reads, got {gate.ReadCount}.");
        await using (var scope = factory.Services.CreateAsyncScope())
        {
            var db = scope.ServiceProvider.GetRequiredService<JarvisDbContext>();
            Assert.Equal(1, await db.Messages.CountAsync(
                message => message.ConversationId == conversationId));
            Assert.Equal(1, await db.IdempotencyRecords.CountAsync(
                record => record.Scope == $"conversations:{conversationId}:messages:typed"
                    && record.IdempotencyKey == "race-typed"));
        }
    }

    [Fact]
    public async Task CreateIdempotencyReplaysAndDifferentPayloadConflicts()
    {
        using var client = CreateAuthenticatedClient();
        var idempotencyKey = $"idem-conversation-{Guid.CreateVersion7():N}";
        using var firstRequest = new HttpRequestMessage(HttpMethod.Post, "/api/v1/conversations")
        {
            Content = JsonContent.Create(new CreateConversationRequest("original"))
        };
        firstRequest.Headers.Add("Idempotency-Key", idempotencyKey);
        var firstResponse = await client.SendAsync(firstRequest);
        Assert.Equal(HttpStatusCode.Created, firstResponse.StatusCode);
        var first = await firstResponse.Content.ReadFromJsonAsync<ConversationResponse>();
        Assert.NotNull(first);

        using var replayRequest = new HttpRequestMessage(HttpMethod.Post, "/api/v1/conversations")
        {
            Content = JsonContent.Create(new CreateConversationRequest("original"))
        };
        replayRequest.Headers.Add("Idempotency-Key", idempotencyKey);
        var replayResponse = await client.SendAsync(replayRequest);
        Assert.Equal(HttpStatusCode.Created, replayResponse.StatusCode);
        var replay = await replayResponse.Content.ReadFromJsonAsync<ConversationResponse>();
        Assert.NotNull(replay);
        Assert.Equal(first.Id, replay.Id);
        Assert.Equal($"/api/v1/conversations/{first.Id}", replayResponse.Headers.Location?.OriginalString);

        using var conflictRequest = new HttpRequestMessage(HttpMethod.Post, "/api/v1/conversations")
        {
            Content = JsonContent.Create(new CreateConversationRequest("different"))
        };
        conflictRequest.Headers.Add("Idempotency-Key", idempotencyKey);
        var conflictResponse = await client.SendAsync(conflictRequest);
        Assert.Equal(HttpStatusCode.Conflict, conflictResponse.StatusCode);
    }

    [Fact]
    public async Task MissingIdempotencyKeyIsAProblemDetailsValidationError()
    {
        using var client = CreateAuthenticatedClient();
        var response = await client.PostAsJsonAsync(
            "/api/v1/conversations",
            new CreateConversationRequest("missing key"));

        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
        Assert.Equal("application/problem+json", response.Content.Headers.ContentType?.MediaType);
    }

    [Fact]
    public async Task WriteIdentifiersAndTitleCannotExceedStorageLimits()
    {
        using var client = CreateAuthenticatedClient();

        using var longTitleRequest = new HttpRequestMessage(HttpMethod.Post, "/api/v1/conversations")
        {
            Content = JsonContent.Create(new CreateConversationRequest(new string('t', 501)))
        };
        longTitleRequest.Headers.Add("Idempotency-Key", "length-title");
        var longTitleResponse = await client.SendAsync(longTitleRequest);
        Assert.Equal(HttpStatusCode.BadRequest, longTitleResponse.StatusCode);

        using var longKeyRequest = new HttpRequestMessage(HttpMethod.Post, "/api/v1/conversations")
        {
            Content = JsonContent.Create(new CreateConversationRequest("valid title"))
        };
        longKeyRequest.Headers.Add("Idempotency-Key", new string('k', 201));
        var longKeyResponse = await client.SendAsync(longKeyRequest);
        Assert.Equal(HttpStatusCode.BadRequest, longKeyResponse.StatusCode);

        var conversation = await CreateConversationAsync(client, "valid title");
        using var longClientRequest = new HttpRequestMessage(
            HttpMethod.Post,
            $"/api/v1/conversations/{conversation.Id}/messages/typed")
        {
            Content = JsonContent.Create(new TypedMessageRequest(new string('c', 201), "text"))
        };
        longClientRequest.Headers.Add("Idempotency-Key", "length-client-request");
        var longClientResponse = await client.SendAsync(longClientRequest);
        Assert.Equal(HttpStatusCode.BadRequest, longClientResponse.StatusCode);
    }

    [Fact]
    public async Task ConversationOwnershipIsEnforced()
    {
        using var client = CreateAuthenticatedClient();
        var response = await client.GetAsync($"/api/v1/conversations/{Guid.CreateVersion7()}");

        Assert.Equal(HttpStatusCode.NotFound, response.StatusCode);
    }

    private HttpClient CreateAuthenticatedClient()
    {
        return CreateAuthenticatedClient(_factory);
    }

    private static HttpClient CreateAuthenticatedClient(TestApplicationFactory factory)
    {
        var client = factory.CreateClient();
        client.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", factory.Token);
        return client;
    }

    private static async Task<ConversationResponse> CreateConversationAsync(HttpClient client, string title)
    {
        using var request = new HttpRequestMessage(HttpMethod.Post, "/api/v1/conversations")
        {
            Content = JsonContent.Create(new CreateConversationRequest(title))
        };
        request.Headers.Add("Idempotency-Key", $"create-{Guid.CreateVersion7():N}");
        var response = await client.SendAsync(request);
        Assert.Equal(HttpStatusCode.Created, response.StatusCode);
        return (await response.Content.ReadFromJsonAsync<ConversationResponse>())!;
    }

    private static async Task<TypedMessageResponse> AddTypedMessageAsync(
        HttpClient client,
        Guid conversationId,
        string clientRequestId,
        string text,
        string idempotencyKey)
    {
        using var request = new HttpRequestMessage(
            HttpMethod.Post,
            $"/api/v1/conversations/{conversationId}/messages/typed")
        {
            Content = JsonContent.Create(new TypedMessageRequest(clientRequestId, text))
        };
        request.Headers.Add("Idempotency-Key", idempotencyKey);
        var response = await client.SendAsync(request);
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        return (await response.Content.ReadFromJsonAsync<TypedMessageResponse>())!;
    }

    private sealed class IdempotencyReadGate : DbCommandInterceptor
    {
        private readonly TaskCompletionSource _twoReadsReached = new(
            TaskCreationOptions.RunContinuationsAsynchronously);
        private readonly TaskCompletionSource _release = new(
            TaskCreationOptions.RunContinuationsAsynchronously);
        private int _reads;

        public Task TwoReadsReached => _twoReadsReached.Task;

        public int ReadCount => Volatile.Read(ref _reads);

        public void Release() => _release.TrySetResult();

        public override async ValueTask<InterceptionResult<DbDataReader>> ReaderExecutingAsync(
            DbCommand command,
            CommandEventData eventData,
            InterceptionResult<DbDataReader> result,
            CancellationToken cancellationToken = default)
        {
            if (command.CommandText.Contains("IdempotencyRecords", StringComparison.Ordinal)
                && command.CommandText.Contains("SELECT", StringComparison.OrdinalIgnoreCase)
                && Interlocked.Increment(ref _reads) <= 2)
            {
                if (Volatile.Read(ref _reads) == 2)
                {
                    _twoReadsReached.TrySetResult();
                }

                await _release.Task.WaitAsync(cancellationToken);
            }

            return result;
        }
    }
}
