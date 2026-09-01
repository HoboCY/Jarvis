using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Text.Json;
using Jarvis.Application.Realtime;
using Jarvis.Contracts;
using Jarvis.Infrastructure.Data;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Xunit;

namespace Jarvis.Api.IntegrationTests;

public sealed class RealtimeApiTests
{
    [Fact]
    public async Task AuthenticatedDesktopCanBootstrapSecretLifecycleAndIngestWithoutPersistingSecret()
    {
        var provider = new FakeRealtimeClientSecretProvider();
        using var factory = new TestApplicationFactory(null, true, null, null, null, provider);
        using var client = CreateAuthenticatedClient(factory);

        using var bootstrap = await PostAsync(client, "/api/v1/realtime/desktop-device", new { }, "bootstrap");
        Assert.Equal(HttpStatusCode.OK, bootstrap.StatusCode);
        var device = await bootstrap.Content.ReadFromJsonAsync<DesktopDeviceBootstrapResponse>();
        Assert.NotNull(device);

        using var conversationRequest = new HttpRequestMessage(HttpMethod.Post, "/api/v1/conversations")
        {
            Content = JsonContent.Create(new CreateConversationRequest("realtime"))
        };
        conversationRequest.Headers.Add("Idempotency-Key", "realtime-conversation");
        using var conversationResponse = await client.SendAsync(conversationRequest);
        var conversation = await conversationResponse.Content.ReadFromJsonAsync<ConversationResponse>();
        Assert.NotNull(conversation);

        using var secretRequest = new HttpRequestMessage(HttpMethod.Post, "/api/v1/realtime/client-secrets")
        {
            Content = JsonContent.Create(new RealtimeClientSecretRequest(conversation.Id, device!.DeviceId))
        };
        secretRequest.Headers.Add("Idempotency-Key", "realtime-secret");
        using var secretResponse = await client.SendAsync(secretRequest);
        Assert.Equal(HttpStatusCode.OK, secretResponse.StatusCode);
        var secret = await secretResponse.Content.ReadFromJsonAsync<RealtimeClientSecretResponse>();
        Assert.NotNull(secret);
        Assert.Equal("ek_test_ephemeral", secret.ClientSecret);
        using var secretJson = JsonDocument.Parse(await secretResponse.Content.ReadAsStringAsync());
        Assert.True(secretJson.RootElement.TryGetProperty("expiresAt", out _));
        Assert.True(secretJson.RootElement.TryGetProperty("sessionRotationAt", out _));
        Assert.False(secretJson.RootElement.TryGetProperty("expiresAtMs", out _));
        Assert.False(secretJson.RootElement.TryGetProperty("sessionRotationAtMs", out _));
        Assert.False(secretJson.RootElement.TryGetProperty("externalSessionId", out _));
        Assert.StartsWith("You are Jarvis.", secret.Instructions, StringComparison.Ordinal);
        Assert.Contains("Jarvis is your sole product identity and public name.", secret.Instructions, StringComparison.Ordinal);
        Assert.Contains("Never identify yourself as ChatGPT", secret.Instructions, StringComparison.Ordinal);
        Assert.True(secret.ExpiresAt > DateTimeOffset.UtcNow.ToUnixTimeMilliseconds());
        Assert.True(secret.SessionRotationAt > secret.ExpiresAt);

        using var replayRequest = new HttpRequestMessage(HttpMethod.Post, "/api/v1/realtime/client-secrets")
        {
            Content = JsonContent.Create(new RealtimeClientSecretRequest(conversation.Id, device.DeviceId))
        };
        replayRequest.Headers.Add("Idempotency-Key", "realtime-secret");
        using var replayResponse = await client.SendAsync(replayRequest);
        Assert.Equal(HttpStatusCode.OK, replayResponse.StatusCode);
        var replay = await replayResponse.Content.ReadFromJsonAsync<RealtimeClientSecretResponse>();
        Assert.Equal(secret.RealtimeSessionId, replay!.RealtimeSessionId);
        Assert.Equal(secret.Instructions, replay.Instructions);
        Assert.Equal(1, provider.CallCount);

        using var conflictingSecretRequest = new HttpRequestMessage(HttpMethod.Post, "/api/v1/realtime/client-secrets")
        {
            Content = JsonContent.Create(new RealtimeClientSecretRequest(conversation.Id, device.DeviceId, "alloy"))
        };
        conflictingSecretRequest.Headers.Add("Idempotency-Key", "realtime-secret");
        using var conflictingSecretResponse = await client.SendAsync(conflictingSecretRequest);
        Assert.Equal(HttpStatusCode.Conflict, conflictingSecretResponse.StatusCode);

        using var replayAfterConflictRequest = new HttpRequestMessage(HttpMethod.Post, "/api/v1/realtime/client-secrets")
        {
            Content = JsonContent.Create(new RealtimeClientSecretRequest(conversation.Id, device.DeviceId))
        };
        replayAfterConflictRequest.Headers.Add("Idempotency-Key", "realtime-secret");
        using var replayAfterConflictResponse = await client.SendAsync(replayAfterConflictRequest);
        Assert.Equal(HttpStatusCode.OK, replayAfterConflictResponse.StatusCode);
        var replayAfterConflict = await replayAfterConflictResponse.Content.ReadFromJsonAsync<RealtimeClientSecretResponse>();
        Assert.Equal(secret.RealtimeSessionId, replayAfterConflict!.RealtimeSessionId);
        Assert.Equal(1, provider.CallCount);

        using var connected = await PostAsync(
            client,
            $"/api/v1/realtime/sessions/{secret.RealtimeSessionId}/connected",
            new RealtimeSessionConnectedRequest("actual-oai-session-1"),
            "realtime-connected");
        Assert.Equal(HttpStatusCode.OK, connected.StatusCode);

        var events = new RealtimeEventsIngestRequest(
            1,
            [
                new("user-partial", "item-user", secret.RealtimeSessionId, MessageRoleValue.User, "voice", RealtimeEventStatusValue.Partial, "你好"),
                new("user-complete", "item-user", secret.RealtimeSessionId, MessageRoleValue.User, "voice", RealtimeEventStatusValue.Completed, "你好，继续"),
                new("assistant-partial", "item-assistant", secret.RealtimeSessionId, MessageRoleValue.Assistant, "audioWithTranscript", RealtimeEventStatusValue.Streaming, "好的"),
                new("assistant-interrupted", "item-assistant", secret.RealtimeSessionId, MessageRoleValue.Assistant, "audioWithTranscript", RealtimeEventStatusValue.Interrupted, "好的，我先停下"),
                new("assistant-interrupted", "item-assistant", secret.RealtimeSessionId, MessageRoleValue.Assistant, "audioWithTranscript", RealtimeEventStatusValue.Interrupted, "好的，我先停下")
            ]);
        using var ingest = await PostAsync(
            client,
            $"/api/v1/conversations/{conversation.Id}/realtime-events:ingest",
            events,
            "realtime-events");
        Assert.Equal(HttpStatusCode.OK, ingest.StatusCode);
        var ingestResult = await ingest.Content.ReadFromJsonAsync<RealtimeEventsIngestResponse>();
        Assert.Equal(4, ingestResult!.Accepted);
        Assert.Equal(1, ingestResult.Deduplicated);

        var rotatedSecret = await CreateSecretAsync(
            client,
            conversation.Id,
            device.DeviceId,
            "realtime-secret-rotated");
        Assert.True(rotatedSecret.ContextVersion > secret.ContextVersion);

        using var rotated = await PostAsync(
            client,
            $"/api/v1/realtime/sessions/{secret.RealtimeSessionId}/ended",
            new RealtimeSessionEndedRequest("idle rotation", RealtimeSessionStatusValue.Rotated),
            "realtime-rotated");
        Assert.Equal(HttpStatusCode.OK, rotated.StatusCode);

        using var connectedAgain = await PostAsync(
            client,
            $"/api/v1/realtime/sessions/{rotatedSecret.RealtimeSessionId}/connected",
            new RealtimeSessionConnectedRequest("actual-oai-session-2"),
            "realtime-connected-2");
        Assert.Equal(HttpStatusCode.OK, connectedAgain.StatusCode);

        using var secondIngest = await PostAsync(
            client,
            $"/api/v1/conversations/{conversation.Id}/realtime-events:ingest",
            new RealtimeEventsIngestRequest(
                1,
                [new("rotated-user", "item-rotated-user", rotatedSecret.RealtimeSessionId, MessageRoleValue.User, "typedText", RealtimeEventStatusValue.Completed, "轮换后继续")]),
            "realtime-events-rotated");
        Assert.Equal(HttpStatusCode.OK, secondIngest.StatusCode);

        using var ended = await PostAsync(
            client,
            $"/api/v1/realtime/sessions/{rotatedSecret.RealtimeSessionId}/ended",
            new RealtimeSessionEndedRequest("user disconnected"),
            "realtime-ended");
        Assert.Equal(HttpStatusCode.OK, ended.StatusCode);

        using var repeatedRotation = await PostAsync(
            client,
            $"/api/v1/realtime/sessions/{secret.RealtimeSessionId}/ended",
            new RealtimeSessionEndedRequest("duplicate rotation", RealtimeSessionStatusValue.Rotated),
            "realtime-rotated-with-another-key");
        Assert.Equal(HttpStatusCode.OK, repeatedRotation.StatusCode);
        var repeatedRotationBody = await repeatedRotation.Content.ReadFromJsonAsync<RealtimeSessionResponse>();
        Assert.Equal("idle rotation", repeatedRotationBody!.EndReason);

        var detail = await client.GetFromJsonAsync<ConversationResponse>(
            $"/api/v1/conversations/{conversation.Id}");
        Assert.NotNull(detail);
        Assert.Equal(3, detail.MessageCount);
        Assert.Contains(detail.Messages, message => message.Status == MessageStatusValue.Interrupted);
        Assert.Contains(detail.Messages, message => message.RealtimeSessionId == secret.RealtimeSessionId);
        Assert.Contains(detail.Messages, message => message.RealtimeSessionId == rotatedSecret.RealtimeSessionId);

        await using var scope = factory.Services.CreateAsyncScope();
        var db = scope.ServiceProvider.GetRequiredService<JarvisDbContext>();
        var sessions = await db.RealtimeSessions.ToListAsync();
        Assert.Equal(2, sessions.Count);
        Assert.Contains(sessions, session => session.Status == Jarvis.Domain.Conversations.RealtimeSessionStatus.Rotated);
        Assert.Contains(sessions, session => session.Status == Jarvis.Domain.Conversations.RealtimeSessionStatus.Disconnected);
        Assert.Contains(sessions, session => session.ExternalSessionId == "actual-oai-session-1");
        Assert.Contains(sessions, session => session.ExternalSessionId == "actual-oai-session-2");
        var durableJson = string.Join(
            "\n",
            await db.IdempotencyRecords.Select(record => record.ResponseJson).ToListAsync());
        Assert.DoesNotContain("ek_test_ephemeral", durableJson, StringComparison.Ordinal);
        Assert.DoesNotContain("ek_test_ephemeral", JsonSerializer.Serialize(await db.RealtimeSessions.ToListAsync()), StringComparison.Ordinal);
        Assert.DoesNotContain(
            "ek_test_ephemeral",
            string.Join("\n", await db.OutboxMessages.Select(message => message.PayloadJson).ToListAsync()),
            StringComparison.Ordinal);
        var invalidations = await db.OutboxMessages
            .Where(message => message.EventType == "realtime.sessionInvalidated")
            .Select(message => message.PayloadJson)
            .ToListAsync();
        Assert.Equal(2, invalidations.Count);
        Assert.Contains(invalidations, payload => payload.Contains(secret.RealtimeSessionId.ToString(), StringComparison.Ordinal));
        Assert.Contains(invalidations, payload => payload.Contains(rotatedSecret.RealtimeSessionId.ToString(), StringComparison.Ordinal));
    }

    [Fact]
    public async Task RealtimeEventsCannotCrossConversationAndSecretNeedsAuthentication()
    {
        var provider = new FakeRealtimeClientSecretProvider();
        using var factory = new TestApplicationFactory(null, true, null, null, null, provider);
        using var anonymous = factory.CreateClient();
        using var unauthorized = new HttpRequestMessage(HttpMethod.Post, "/api/v1/realtime/client-secrets")
        {
            Content = JsonContent.Create(new RealtimeClientSecretRequest(Guid.NewGuid(), Guid.NewGuid()))
        };
        unauthorized.Headers.Add("Idempotency-Key", "unauthorized-secret");
        using var unauthorizedResponse = await anonymous.SendAsync(unauthorized);
        Assert.Equal(HttpStatusCode.Unauthorized, unauthorizedResponse.StatusCode);

        using var client = CreateAuthenticatedClient(factory);
        var conversationA = await CreateConversationAsync(client, "A", "conversation-a");
        var conversationB = await CreateConversationAsync(client, "B", "conversation-b");
        var deviceResponse = await PostAsync(client, "/api/v1/realtime/desktop-device", new { }, "bootstrap");
        var device = (await deviceResponse.Content.ReadFromJsonAsync<DesktopDeviceBootstrapResponse>())!;
        var secret = await CreateSecretAsync(client, conversationA.Id, device.DeviceId, "secret-a");

        using var crossConversation = await PostAsync(
            client,
            $"/api/v1/conversations/{conversationB.Id}/realtime-events:ingest",
            new RealtimeEventsIngestRequest(
                1,
                [new("cross", "cross-item", secret.RealtimeSessionId, MessageRoleValue.User, "voice", RealtimeEventStatusValue.Completed, "no")]),
            "cross-events");
        Assert.Equal(HttpStatusCode.Conflict, crossConversation.StatusCode);
    }

    [Fact]
    public async Task RealtimeEventWithMaximumEventIdUsesBoundedIdempotencyScope()
    {
        var provider = new FakeRealtimeClientSecretProvider();
        using var factory = new TestApplicationFactory(null, true, null, null, null, provider);
        using var client = CreateAuthenticatedClient(factory);
        var conversation = await CreateConversationAsync(client, "long-event", "long-event-conversation");
        var deviceResponse = await PostAsync(client, "/api/v1/realtime/desktop-device", new { }, "long-event-device");
        var device = (await deviceResponse.Content.ReadFromJsonAsync<DesktopDeviceBootstrapResponse>())!;
        var secret = await CreateSecretAsync(client, conversation.Id, device.DeviceId, "long-event-secret");
        var eventId = new string('e', 200);

        using var response = await PostAsync(
            client,
            $"/api/v1/conversations/{conversation.Id}/realtime-events:ingest",
            new RealtimeEventsIngestRequest(
                1,
                [new(eventId, "long-event-item", secret.RealtimeSessionId, MessageRoleValue.User, "voice", RealtimeEventStatusValue.Completed, "最大长度")]),
            "long-event-ingest");

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
    }

    [Fact]
    public async Task ConcurrentRealtimeBatchesUseUniqueSequencesAndStableBatchReplay()
    {
        var provider = new FakeRealtimeClientSecretProvider();
        using var factory = new TestApplicationFactory(null, true, null, null, null, provider);
        using var client = CreateAuthenticatedClient(factory);
        var conversation = await CreateConversationAsync(client, "concurrent-events", "concurrent-events-conversation");
        var deviceResponse = await PostAsync(client, "/api/v1/realtime/desktop-device", new { }, "concurrent-events-device");
        var device = (await deviceResponse.Content.ReadFromJsonAsync<DesktopDeviceBootstrapResponse>())!;
        var session = await CreateSecretAsync(client, conversation.Id, device.DeviceId, "concurrent-events-session");

        var firstBatch = new RealtimeEventsIngestRequest(
            1,
            [new("concurrent-event-1", "concurrent-item-1", session.RealtimeSessionId, MessageRoleValue.User, "voice", RealtimeEventStatusValue.Completed, "第一批")]);
        var secondBatch = new RealtimeEventsIngestRequest(
            1,
            [new("concurrent-event-2", "concurrent-item-2", session.RealtimeSessionId, MessageRoleValue.User, "voice", RealtimeEventStatusValue.Completed, "第二批")]);
        var thirdBatch = new RealtimeEventsIngestRequest(
            1,
            [new("concurrent-event-3", "concurrent-item-3", session.RealtimeSessionId, MessageRoleValue.User, "voice", RealtimeEventStatusValue.Completed, "第三批")]);

        var sameKeyResponses = await Task.WhenAll(
            PostAsync(client, $"/api/v1/conversations/{conversation.Id}/realtime-events:ingest", firstBatch, "concurrent-batch-same"),
            PostAsync(client, $"/api/v1/conversations/{conversation.Id}/realtime-events:ingest", firstBatch, "concurrent-batch-same"));
        using var sameKeyFirst = sameKeyResponses[0];
        using var sameKeySecond = sameKeyResponses[1];
        Assert.Equal(HttpStatusCode.OK, sameKeyFirst.StatusCode);
        Assert.Equal(HttpStatusCode.OK, sameKeySecond.StatusCode);
        var sameKeyFirstBody = await sameKeyFirst.Content.ReadFromJsonAsync<RealtimeEventsIngestResponse>();
        var sameKeySecondBody = await sameKeySecond.Content.ReadFromJsonAsync<RealtimeEventsIngestResponse>();
        Assert.NotNull(sameKeyFirstBody);
        Assert.NotNull(sameKeySecondBody);
        Assert.Equal(sameKeyFirstBody.Version, sameKeySecondBody.Version);
        Assert.Equal(sameKeyFirstBody.Accepted, sameKeySecondBody.Accepted);
        Assert.Equal(sameKeyFirstBody.Deduplicated, sameKeySecondBody.Deduplicated);
        Assert.True(sameKeyFirstBody.MessageIds.SequenceEqual(sameKeySecondBody.MessageIds));
        Assert.Equal(1, sameKeyFirstBody.Accepted);

        var responses = await Task.WhenAll(
            PostAsync(client, $"/api/v1/conversations/{conversation.Id}/realtime-events:ingest", secondBatch, "concurrent-batch-2"),
            PostAsync(client, $"/api/v1/conversations/{conversation.Id}/realtime-events:ingest", thirdBatch, "concurrent-batch-3"));
        using var firstResponse = responses[0];
        using var secondResponse = responses[1];
        Assert.Equal(HttpStatusCode.OK, firstResponse.StatusCode);
        Assert.Equal(HttpStatusCode.OK, secondResponse.StatusCode);

        await using var scope = factory.Services.CreateAsyncScope();
        var db = scope.ServiceProvider.GetRequiredService<JarvisDbContext>();
        var messages = await db.Messages
            .Where(message => message.ConversationId == conversation.Id)
            .ToListAsync();
        Assert.Equal(3, messages.Count);
        Assert.Equal(3, messages.Select(message => message.Sequence).Distinct().Count());
    }

    [Fact]
    public async Task ContextVersionAdvancesWhenAnExistingRealtimeItemTextIsUpdated()
    {
        var provider = new FakeRealtimeClientSecretProvider();
        using var factory = new TestApplicationFactory(null, true, null, null, null, provider);
        using var client = CreateAuthenticatedClient(factory);
        var conversation = await CreateConversationAsync(client, "context-version", "context-version-conversation");
        var deviceResponse = await PostAsync(client, "/api/v1/realtime/desktop-device", new { }, "context-version-device");
        var device = (await deviceResponse.Content.ReadFromJsonAsync<DesktopDeviceBootstrapResponse>())!;
        var session = await CreateSecretAsync(client, conversation.Id, device.DeviceId, "context-version-session");

        using var streaming = await PostAsync(
            client,
            $"/api/v1/conversations/{conversation.Id}/realtime-events:ingest",
            new RealtimeEventsIngestRequest(
                1,
                [new("context-streaming", "context-version-item", session.RealtimeSessionId, MessageRoleValue.Assistant, "audioWithTranscript", RealtimeEventStatusValue.Streaming, "初始")]),
            "context-version-streaming");
        Assert.Equal(HttpStatusCode.OK, streaming.StatusCode);
        var before = await CreateSecretAsync(client, conversation.Id, device.DeviceId, "context-version-before");

        using var completed = await PostAsync(
            client,
            $"/api/v1/conversations/{conversation.Id}/realtime-events:ingest",
            new RealtimeEventsIngestRequest(
                1,
                [new("context-completed", "context-version-item", session.RealtimeSessionId, MessageRoleValue.Assistant, "audioWithTranscript", RealtimeEventStatusValue.Completed, "最终")]),
            "context-version-completed");
        Assert.Equal(HttpStatusCode.OK, completed.StatusCode);
        var after = await CreateSecretAsync(client, conversation.Id, device.DeviceId, "context-version-after");

        Assert.True(after.ContextVersion > before.ContextVersion);
    }

    [Fact]
    public async Task RealtimeConversationAndSessionMetadataSurviveApiRestartWithoutSecret()
    {
        var databasePath = Path.Combine(Path.GetTempPath(), $"jarvis-realtime-restart-{Guid.NewGuid():N}.db");
        Guid conversationId;
        Guid sessionId;
        try
        {
            using (var firstFactory = new TestApplicationFactory(
                databasePath,
                false,
                null,
                null,
                null,
                new FakeRealtimeClientSecretProvider()))
            {
                using var firstClient = CreateAuthenticatedClient(firstFactory);
                var conversation = await CreateConversationAsync(firstClient, "restart", "restart-conversation");
                conversationId = conversation.Id;
                var deviceResponse = await PostAsync(firstClient, "/api/v1/realtime/desktop-device", new { }, "restart-device");
                var device = (await deviceResponse.Content.ReadFromJsonAsync<DesktopDeviceBootstrapResponse>())!;
                var secret = await CreateSecretAsync(firstClient, conversationId, device.DeviceId, "restart-secret");
                sessionId = secret.RealtimeSessionId;

                using var ingest = await PostAsync(
                    firstClient,
                    $"/api/v1/conversations/{conversationId}/realtime-events:ingest",
                    new RealtimeEventsIngestRequest(
                        1,
                        [new("restart-event", "restart-item", sessionId, MessageRoleValue.User, "voice", RealtimeEventStatusValue.Completed, "重启后仍在")]),
                    "restart-events");
                Assert.Equal(HttpStatusCode.OK, ingest.StatusCode);
            }

            using (var secondFactory = new TestApplicationFactory(
                databasePath,
                true,
                null,
                null,
                null,
                new FakeRealtimeClientSecretProvider()))
            {
                using var secondClient = CreateAuthenticatedClient(secondFactory);
                var conversation = await secondClient.GetFromJsonAsync<ConversationResponse>(
                    $"/api/v1/conversations/{conversationId}");
                Assert.NotNull(conversation);
                Assert.Equal(1, conversation!.MessageCount);
                Assert.Equal(sessionId, conversation.Messages[0].RealtimeSessionId);

                await using var scope = secondFactory.Services.CreateAsyncScope();
                var db = scope.ServiceProvider.GetRequiredService<JarvisDbContext>();
                var session = await db.RealtimeSessions.SingleAsync(item => item.Id == sessionId);
                Assert.Equal(conversationId, session.ConversationId);
                Assert.DoesNotContain(
                    "ek_test_ephemeral",
                    JsonSerializer.Serialize(session),
                    StringComparison.Ordinal);
            }
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

    [Fact]
    public async Task ClientSecretRateLimitReturnsProblemDetails()
    {
        var provider = new FakeRealtimeClientSecretProvider();
        using var factory = new TestApplicationFactory(null, true, null, null, null, provider);
        using var client = CreateAuthenticatedClient(factory);
        var conversation = await CreateConversationAsync(client, "rate-limit", "rate-limit-conversation");
        var deviceResponse = await PostAsync(client, "/api/v1/realtime/desktop-device", new { }, "rate-limit-device");
        var device = (await deviceResponse.Content.ReadFromJsonAsync<DesktopDeviceBootstrapResponse>())!;

        for (var index = 0; index < 10; index++)
        {
            using var response = await PostAsync(
                client,
                "/api/v1/realtime/client-secrets",
                new RealtimeClientSecretRequest(conversation.Id, device.DeviceId),
                $"rate-limit-{index}");
            Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        }

        using var rejected = await PostAsync(
            client,
            "/api/v1/realtime/client-secrets",
            new RealtimeClientSecretRequest(conversation.Id, device.DeviceId),
            "rate-limit-rejected");
        Assert.Equal(HttpStatusCode.TooManyRequests, rejected.StatusCode);
        Assert.Equal("application/problem+json", rejected.Content.Headers.ContentType?.MediaType);
    }

    [Fact]
    public async Task ConcurrentSameClientSecretRequestUsesOneProviderMintAndOneDurableSession()
    {
        var provider = new FakeRealtimeClientSecretProvider();
        using var factory = new TestApplicationFactory(null, true, null, null, null, provider);
        using var client = CreateAuthenticatedClient(factory);
        var conversation = await CreateConversationAsync(client, "single-flight", "single-flight-conversation");
        var deviceResponse = await PostAsync(client, "/api/v1/realtime/desktop-device", new { }, "single-flight-device");
        var device = (await deviceResponse.Content.ReadFromJsonAsync<DesktopDeviceBootstrapResponse>())!;

        var responses = await Task.WhenAll(Enumerable.Range(0, 8).Select(async _ =>
        {
            using var response = await PostAsync(
                client,
                "/api/v1/realtime/client-secrets",
                new RealtimeClientSecretRequest(conversation.Id, device.DeviceId),
                "single-flight-secret");
            return (response.StatusCode, Body: await response.Content.ReadFromJsonAsync<RealtimeClientSecretResponse>());
        }));

        Assert.All(responses, response => Assert.Equal(HttpStatusCode.OK, response.StatusCode));
        Assert.NotNull(responses[0].Body);
        Assert.All(responses, response => Assert.Equal(responses[0].Body!.RealtimeSessionId, response.Body!.RealtimeSessionId));
        Assert.All(responses, response => Assert.Equal(responses[0].Body!.ClientSecret, response.Body!.ClientSecret));
        Assert.Equal(1, provider.CallCount);
    }

    private static HttpClient CreateAuthenticatedClient(TestApplicationFactory factory)
    {
        var client = factory.CreateClient();
        client.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", factory.Token);
        return client;
    }

    private static async Task<ConversationResponse> CreateConversationAsync(HttpClient client, string title, string key)
    {
        using var request = new HttpRequestMessage(HttpMethod.Post, "/api/v1/conversations")
        {
            Content = JsonContent.Create(new CreateConversationRequest(title))
        };
        request.Headers.Add("Idempotency-Key", key);
        using var response = await client.SendAsync(request);
        response.EnsureSuccessStatusCode();
        return (await response.Content.ReadFromJsonAsync<ConversationResponse>())!;
    }

    private static async Task<RealtimeClientSecretResponse> CreateSecretAsync(
        HttpClient client,
        Guid conversationId,
        Guid deviceId,
        string key)
    {
        using var response = await PostAsync(
            client,
            "/api/v1/realtime/client-secrets",
            new RealtimeClientSecretRequest(conversationId, deviceId),
            key);
        response.EnsureSuccessStatusCode();
        return (await response.Content.ReadFromJsonAsync<RealtimeClientSecretResponse>())!;
    }

    private static async Task<HttpResponseMessage> PostAsync(
        HttpClient client,
        string path,
        object body,
        string idempotencyKey)
    {
        var request = new HttpRequestMessage(HttpMethod.Post, path)
        {
            Content = JsonContent.Create(body)
        };
        request.Headers.Add("Idempotency-Key", idempotencyKey);
        return await client.SendAsync(request);
    }

    private sealed class FakeRealtimeClientSecretProvider : IRealtimeClientSecretProvider
    {
        public int CallCount { get; private set; }

        public Task<RealtimeClientSecretProviderResponse> CreateAsync(
            RealtimeClientSecretProviderRequest request,
            CancellationToken cancellationToken)
        {
            CallCount++;
            _ = request;
            _ = cancellationToken;
            return Task.FromResult(new RealtimeClientSecretProviderResponse(
                "ek_test_ephemeral",
                DateTimeOffset.UtcNow.AddMinutes(5).ToUnixTimeMilliseconds(),
                $"oai-session-test-{CallCount}",
                "gpt-4o-realtime-preview",
                "alloy",
                "https://api.openai.test/v1/realtime/calls"));
        }
    }
}
