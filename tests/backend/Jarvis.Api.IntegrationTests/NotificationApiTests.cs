using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Text.Json;
using Jarvis.Domain.Notifications;
using Jarvis.Infrastructure.Data;
using Jarvis.Infrastructure.Tasks;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Xunit;

namespace Jarvis.Api.IntegrationTests;

public sealed class NotificationApiTests : IClassFixture<TestApplicationFactory>
{
    private static readonly string[] RequiredCapabilities = [];
    private readonly TestApplicationFactory factory;

    public NotificationApiTests(TestApplicationFactory factory)
    {
        this.factory = factory;
    }

    [Fact]
    public async Task UnreadNotificationsCanBeDeliveredAndReadWithIdempotentWrites()
    {
        using var client = factory.CreateClient();
        client.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", factory.Token);
        var conversationId = await CreateConversationAsync(client);
        var taskId = await CreateTaskAsync(client, conversationId);

        await using (var scope = factory.Services.CreateAsyncScope())
        {
            Assert.True(await scope.ServiceProvider.GetRequiredService<FakeDelayWorker>().ProcessOneAsync());
        }

        var unread = await client.GetFromJsonAsync<JsonElement>("/api/v1/notifications?status=unread");
        var notification = unread.GetProperty("items")[0];
        var notificationId = notification.GetProperty("id").GetGuid();
        Assert.Equal("pending", notification.GetProperty("status").GetString());
        Assert.Equal(0, notification.GetProperty("entityVersion").GetInt64());

        using var delivered = new HttpRequestMessage(HttpMethod.Post, $"/api/v1/notifications/{notificationId}/delivered");
        delivered.Headers.Add("Idempotency-Key", "notification-delivered");
        using var deliveredResponse = await client.SendAsync(delivered);
        deliveredResponse.EnsureSuccessStatusCode();
        var deliveredValue = await deliveredResponse.Content.ReadFromJsonAsync<JsonElement>();
        Assert.Equal("delivered", deliveredValue.GetProperty("status").GetString());
        Assert.True(deliveredValue.GetProperty("entityVersion").GetInt64() > notification.GetProperty("entityVersion").GetInt64());

        using var deliveredReplay = new HttpRequestMessage(HttpMethod.Post, $"/api/v1/notifications/{notificationId}/delivered");
        deliveredReplay.Headers.Add("Idempotency-Key", "notification-delivered");
        using var deliveredReplayResponse = await client.SendAsync(deliveredReplay);
        deliveredReplayResponse.EnsureSuccessStatusCode();

        using var read = new HttpRequestMessage(HttpMethod.Post, $"/api/v1/notifications/{notificationId}/read");
        read.Headers.Add("Idempotency-Key", "notification-read");
        using var readResponse = await client.SendAsync(read);
        readResponse.EnsureSuccessStatusCode();
        var readValue = await readResponse.Content.ReadFromJsonAsync<JsonElement>();
        Assert.Equal("read", readValue.GetProperty("status").GetString());
        Assert.True(readValue.GetProperty("entityVersion").GetInt64() > deliveredValue.GetProperty("entityVersion").GetInt64());

        using var readReplay = new HttpRequestMessage(HttpMethod.Post, $"/api/v1/notifications/{notificationId}/read");
        readReplay.Headers.Add("Idempotency-Key", "notification-read");
        using var readReplayResponse = await client.SendAsync(readReplay);
        readReplayResponse.EnsureSuccessStatusCode();
        var readReplayValue = await readReplayResponse.Content.ReadFromJsonAsync<JsonElement>();
        Assert.Equal("read", readReplayValue.GetProperty("status").GetString());

        var afterRead = await client.GetFromJsonAsync<JsonElement>("/api/v1/notifications?status=unread");
        Assert.Empty(afterRead.GetProperty("items").EnumerateArray());

        var dismissTaskId = await CreateTaskAsync(client, conversationId);
        await using (var workerScope = factory.Services.CreateAsyncScope())
        {
            Assert.True(await workerScope.ServiceProvider.GetRequiredService<FakeDelayWorker>().ProcessOneAsync());
        }

        var afterSecondTask = await client.GetFromJsonAsync<JsonElement>("/api/v1/notifications?status=unread");
        var dismissNotificationId = afterSecondTask.GetProperty("items")
            .EnumerateArray()
            .Single(item => item.GetProperty("taskId").GetGuid() == dismissTaskId)
            .GetProperty("id")
            .GetGuid();
        using var dismiss = new HttpRequestMessage(HttpMethod.Post, $"/api/v1/notifications/{dismissNotificationId}/dismiss");
        dismiss.Headers.Add("Idempotency-Key", "notification-dismiss");
        using var dismissResponse = await client.SendAsync(dismiss);
        dismissResponse.EnsureSuccessStatusCode();
        using var dismissReplay = new HttpRequestMessage(HttpMethod.Post, $"/api/v1/notifications/{dismissNotificationId}/dismiss");
        dismissReplay.Headers.Add("Idempotency-Key", "notification-dismiss");
        using var dismissReplayResponse = await client.SendAsync(dismissReplay);
        dismissReplayResponse.EnsureSuccessStatusCode();
        var dismissValue = await dismissReplayResponse.Content.ReadFromJsonAsync<JsonElement>();
        Assert.Equal("dismissed", dismissValue.GetProperty("status").GetString());
        _ = taskId;
    }

    [Fact]
    public async Task NotificationVersionPreservesMultipleTransitionsInOneSave()
    {
        using var client = factory.CreateClient();
        client.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", factory.Token);
        var conversationId = await CreateConversationAsync(client);
        var taskId = await CreateTaskAsync(client, conversationId);

        await using (var workerScope = factory.Services.CreateAsyncScope())
        {
            Assert.True(await workerScope.ServiceProvider.GetRequiredService<FakeDelayWorker>().ProcessOneAsync());
        }

        await using var scope = factory.Services.CreateAsyncScope();
        var db = scope.ServiceProvider.GetRequiredService<JarvisDbContext>();
        var notification = await db.Notifications.SingleAsync(item => item.TaskId == taskId);
        var nowMs = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        Assert.True(notification.MarkDelivered(nowMs));
        Assert.True(notification.MarkRead(nowMs + 1));
        await db.SaveChangesAsync();

        var persisted = await db.Notifications.AsNoTracking().SingleAsync(item => item.Id == notification.Id);
        Assert.Equal(2, persisted.Version);
    }

    [Fact]
    public async Task ConcurrentNotificationActionWithSameKeyHasOneDurableResult()
    {
        using var isolatedFactory = new TestApplicationFactory(
            databasePath: null,
            deleteDatabaseOnDispose: true,
            outboxPublisher: null);
        using var firstClient = isolatedFactory.CreateClient();
        using var secondClient = isolatedFactory.CreateClient();
        firstClient.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", isolatedFactory.Token);
        secondClient.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", isolatedFactory.Token);
        var conversationId = await CreateConversationAsync(firstClient);
        var taskId = await CreateTaskAsync(firstClient, conversationId);

        await using (var workerScope = isolatedFactory.Services.CreateAsyncScope())
        {
            Assert.True(await workerScope.ServiceProvider.GetRequiredService<FakeDelayWorker>().ProcessOneAsync());
        }

        var unread = await firstClient.GetFromJsonAsync<JsonElement>("/api/v1/notifications?status=unread");
        var notificationId = unread.GetProperty("items")
            .EnumerateArray()
            .Single(item => item.GetProperty("taskId").GetGuid() == taskId)
            .GetProperty("id")
            .GetGuid();

        async Task<HttpResponseMessage> MarkDeliveredAsync(HttpClient client)
        {
            using var request = new HttpRequestMessage(
                HttpMethod.Post,
                $"/api/v1/notifications/{notificationId}/delivered");
            request.Headers.Add("Idempotency-Key", "notification-concurrent-delivered");
            return await client.SendAsync(request);
        }

        var responses = await Task.WhenAll(
            MarkDeliveredAsync(firstClient),
            MarkDeliveredAsync(secondClient));
        var responseDetails = await Task.WhenAll(responses.Select(async response =>
            (response.StatusCode, Body: await response.Content.ReadAsStringAsync())));
        Assert.All(responseDetails, detail => Assert.True(
            detail.StatusCode is System.Net.HttpStatusCode.OK,
            $"Unexpected notification response {detail.StatusCode}: {detail.Body}"));
        foreach (var response in responses)
        {
            response.Dispose();
        }

        await using var verificationScope = isolatedFactory.Services.CreateAsyncScope();
        var db = verificationScope.ServiceProvider.GetRequiredService<JarvisDbContext>();
        var notification = await db.Notifications.AsNoTracking().SingleAsync(item => item.Id == notificationId);
        Assert.Equal(Jarvis.Domain.Notifications.NotificationStatus.Delivered, notification.Status);
        Assert.Equal(1, notification.Version);
        Assert.Equal(
            1,
            await db.IdempotencyRecords.CountAsync(item => item.Scope == $"notifications:{notificationId}:delivered"
                && item.IdempotencyKey == "notification-concurrent-delivered"));
    }

    [Fact]
    public async Task TerminalTaskNotificationCanBeAcknowledgedIdempotently()
    {
        using var isolatedFactory = new TestApplicationFactory(
            databasePath: null,
            deleteDatabaseOnDispose: true,
            outboxPublisher: null);
        using var client = isolatedFactory.CreateClient();
        client.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", isolatedFactory.Token);
        var conversationId = await CreateConversationAsync(client);
        var taskId = await CreateTaskAsync(client, conversationId);

        await using (var workerScope = isolatedFactory.Services.CreateAsyncScope())
        {
            Assert.True(await workerScope.ServiceProvider.GetRequiredService<FakeDelayWorker>().ProcessOneAsync());
        }

        var unread = await client.GetFromJsonAsync<JsonElement>("/api/v1/notifications?status=unread");
        var notification = unread.GetProperty("items")
            .EnumerateArray()
            .Single(item => item.GetProperty("taskId").GetGuid() == taskId);
        var notificationId = notification.GetProperty("id").GetGuid();
        Assert.Equal("[\"acknowledge\"]", notification.GetProperty("actionsJson").GetString());

        using (var invalid = new HttpRequestMessage(
            HttpMethod.Post,
            $"/api/v1/notifications/{notificationId}/actions/run-command"))
        {
            invalid.Headers.Add("Idempotency-Key", "notification-invalid-action");
            using var invalidResponse = await client.SendAsync(invalid);
            Assert.Equal(System.Net.HttpStatusCode.BadRequest, invalidResponse.StatusCode);
        }

        using (var acknowledge = AcknowledgeRequest(notificationId, "notification-acknowledge"))
        using (var acknowledged = await client.SendAsync(acknowledge))
        {
            acknowledged.EnsureSuccessStatusCode();
            var value = await acknowledged.Content.ReadFromJsonAsync<JsonElement>();
            Assert.Equal("actioned", value.GetProperty("status").GetString());
        }

        using (var replay = AcknowledgeRequest(notificationId, "notification-acknowledge"))
        using (var replayed = await client.SendAsync(replay))
        {
            replayed.EnsureSuccessStatusCode();
            var value = await replayed.Content.ReadFromJsonAsync<JsonElement>();
            Assert.Equal("actioned", value.GetProperty("status").GetString());
        }

        using (var secondAction = AcknowledgeRequest(notificationId, "notification-acknowledge-again"))
        using (var conflict = await client.SendAsync(secondAction))
        {
            Assert.Equal(System.Net.HttpStatusCode.Conflict, conflict.StatusCode);
        }

        var afterAction = await client.GetFromJsonAsync<JsonElement>("/api/v1/notifications?status=unread");
        Assert.Empty(afterAction.GetProperty("items").EnumerateArray());

        Guid notOfferedNotificationId;
        await using (var setupScope = isolatedFactory.Services.CreateAsyncScope())
        {
            var setupDb = setupScope.ServiceProvider.GetRequiredService<JarvisDbContext>();
            var userId = await setupDb.Users.Select(item => item.Id).SingleAsync();
            var notOffered = Jarvis.Domain.Notifications.Notification.Create(
                Guid.CreateVersion7(),
                userId,
                conversationId,
                taskId,
                "task.needsUserInput",
                NotificationSeverity.Info,
                "Input required",
                "Use the dedicated task user-input endpoint.",
                $"notification-action-not-offered:{Guid.CreateVersion7():N}",
                DateTimeOffset.UtcNow.ToUnixTimeMilliseconds());
            notOfferedNotificationId = notOffered.Id;
            setupDb.Notifications.Add(notOffered);
            await setupDb.SaveChangesAsync();
        }

        using (var notOffered = AcknowledgeRequest(notOfferedNotificationId, "notification-action-not-offered"))
        using (var conflict = await client.SendAsync(notOffered))
        {
            Assert.Equal(System.Net.HttpStatusCode.Conflict, conflict.StatusCode);
        }

        await using var verificationScope = isolatedFactory.Services.CreateAsyncScope();
        var db = verificationScope.ServiceProvider.GetRequiredService<JarvisDbContext>();
        var persisted = await db.Notifications.AsNoTracking().SingleAsync(item => item.Id == notificationId);
        Assert.Equal(NotificationStatus.Actioned, persisted.Status);
        Assert.Equal(1, persisted.Version);
        Assert.Equal(
            1,
            await db.IdempotencyRecords.CountAsync(item =>
                item.Scope == $"notifications:{notificationId}:actions:acknowledge"
                && item.IdempotencyKey == "notification-acknowledge"));
        Assert.Equal(
            1,
            await db.OutboxMessages.CountAsync(item =>
                item.EventType == "notification.updated"
                && item.PayloadJson.Contains("\"action\":\"acknowledge\"")));
        var createdPayloads = await db.OutboxMessages
            .Where(item => item.EventType == "notification.created")
            .Select(item => item.PayloadJson)
            .ToArrayAsync();
        Assert.Contains(createdPayloads, payloadJson =>
        {
            using var document = JsonDocument.Parse(payloadJson);
            return document.RootElement.GetProperty("payload").GetProperty("actionsJson").GetString()
                == "[\"acknowledge\"]";
        });
    }

    [Fact]
    public async Task ConcurrentAcknowledgeWithSameKeyHasOneDurableResult()
    {
        using var isolatedFactory = new TestApplicationFactory(
            databasePath: null,
            deleteDatabaseOnDispose: true,
            outboxPublisher: null);
        using var firstClient = isolatedFactory.CreateClient();
        using var secondClient = isolatedFactory.CreateClient();
        firstClient.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", isolatedFactory.Token);
        secondClient.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", isolatedFactory.Token);
        var conversationId = await CreateConversationAsync(firstClient);
        var taskId = await CreateTaskAsync(firstClient, conversationId);

        await using (var workerScope = isolatedFactory.Services.CreateAsyncScope())
        {
            Assert.True(await workerScope.ServiceProvider.GetRequiredService<FakeDelayWorker>().ProcessOneAsync());
        }

        var unread = await firstClient.GetFromJsonAsync<JsonElement>("/api/v1/notifications?status=unread");
        var notificationId = unread.GetProperty("items")
            .EnumerateArray()
            .Single(item => item.GetProperty("taskId").GetGuid() == taskId)
            .GetProperty("id")
            .GetGuid();

        async Task<HttpResponseMessage> AcknowledgeAsync(HttpClient client)
        {
            using var request = AcknowledgeRequest(notificationId, "notification-concurrent-acknowledge");
            return await client.SendAsync(request);
        }

        var responses = await Task.WhenAll(
            AcknowledgeAsync(firstClient),
            AcknowledgeAsync(secondClient));
        var details = await Task.WhenAll(responses.Select(async response =>
            (response.StatusCode, Body: await response.Content.ReadAsStringAsync())));
        Assert.All(details, detail => Assert.Equal(
            System.Net.HttpStatusCode.OK,
            detail.StatusCode));
        foreach (var response in responses)
        {
            response.Dispose();
        }

        await using var verificationScope = isolatedFactory.Services.CreateAsyncScope();
        var db = verificationScope.ServiceProvider.GetRequiredService<JarvisDbContext>();
        var persisted = await db.Notifications.AsNoTracking().SingleAsync(item => item.Id == notificationId);
        Assert.Equal(NotificationStatus.Actioned, persisted.Status);
        Assert.Equal(1, persisted.Version);
        Assert.Equal(
            1,
            await db.IdempotencyRecords.CountAsync(item =>
                item.Scope == $"notifications:{notificationId}:actions:acknowledge"
                && item.IdempotencyKey == "notification-concurrent-acknowledge"));
    }

    private static async Task<Guid> CreateConversationAsync(HttpClient client)
    {
        using var request = new HttpRequestMessage(HttpMethod.Post, "/api/v1/conversations")
        {
            Content = JsonContent.Create(new { title = "Notification test" })
        };
        request.Headers.Add("Idempotency-Key", $"notification-conversation-{Guid.CreateVersion7():N}");
        using var response = await client.SendAsync(request);
        response.EnsureSuccessStatusCode();
        using var document = JsonDocument.Parse(await response.Content.ReadAsStringAsync());
        return document.RootElement.GetProperty("id").GetGuid();
    }

    private static HttpRequestMessage AcknowledgeRequest(Guid notificationId, string idempotencyKey)
    {
        var request = new HttpRequestMessage(
            HttpMethod.Post,
            $"/api/v1/notifications/{notificationId}/actions/acknowledge");
        request.Headers.Add("Idempotency-Key", idempotencyKey);
        return request;
    }

    private static async Task<Guid> CreateTaskAsync(HttpClient client, Guid conversationId)
    {
        using var request = new HttpRequestMessage(HttpMethod.Post, "/api/v1/tasks")
        {
            Content = JsonContent.Create(new
            {
                conversationId,
                sourceMessageIds = Array.Empty<Guid>(),
                goal = "notification fake work",
                expectedOutput = "done",
                requiredCapabilities = RequiredCapabilities
            })
        };
        request.Headers.Add("Idempotency-Key", $"notification-task-{Guid.CreateVersion7():N}");
        using var response = await client.SendAsync(request);
        response.EnsureSuccessStatusCode();
        using var document = JsonDocument.Parse(await response.Content.ReadAsStringAsync());
        return document.RootElement.GetProperty("taskId").GetGuid();
    }
}
