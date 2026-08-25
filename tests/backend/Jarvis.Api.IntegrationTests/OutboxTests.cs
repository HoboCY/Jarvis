using System.Net.Http.Json;
using System.Text.Json;
using Jarvis.Application.Outbox;
using Jarvis.Contracts;
using Jarvis.Infrastructure.Data;
using Jarvis.Infrastructure.Outbox;
using Jarvis.Infrastructure.Tasks;
using Jarvis.Domain.Outbox;
using Microsoft.AspNetCore.SignalR.Client;
using Microsoft.Extensions.DependencyInjection;
using Xunit;

namespace Jarvis.Api.IntegrationTests;

public sealed class OutboxTests
{
    private static readonly string[] TaskCapabilities = ["deepReasoning"];

    [Fact]
    public async Task SignalRPublisherDeliversCommittedOutboxEventToAuthenticatedClient()
    {
        using var factory = new TestApplicationFactory();
        using var client = factory.CreateClient();
        client.DefaultRequestHeaders.Authorization = new("Bearer", factory.Token);
        await using var connection = new HubConnectionBuilder()
            .WithUrl(
                new Uri(factory.Server.BaseAddress, "/hubs/client"),
                options =>
                {
                    options.HttpMessageHandlerFactory = _ => factory.Server.CreateHandler();
                    options.AccessTokenProvider = () => Task.FromResult<string?>(factory.Token);
                })
            .Build();
        await connection.StartAsync();

        var received = new TaskCompletionSource<OutboxEventEnvelope>(
            TaskCreationOptions.RunContinuationsAsynchronously);
        connection.On<OutboxEventEnvelope>(
            "conversation.created",
            envelope => received.TrySetResult(envelope));

        using var request = new HttpRequestMessage(HttpMethod.Post, "/api/v1/conversations")
        {
            Content = JsonContent.Create(new { title = "signalr outbox" })
        };
        request.Headers.Add("Idempotency-Key", $"outbox-signalr-{Guid.CreateVersion7():N}");
        var response = await client.SendAsync(request);
        response.EnsureSuccessStatusCode();

        var dispatcher = factory.Services.GetRequiredService<OutboxDispatcher>();
        Assert.Equal(1, await dispatcher.ProcessOnceAsync());
        var envelope = await received.Task.WaitAsync(TimeSpan.FromSeconds(5));

        Assert.Equal("conversation.created", envelope.Type);
        Assert.NotEqual(Guid.Empty, envelope.EventId);
        await connection.StopAsync();
    }

    [Fact]
    public async Task TaskOutboxEventsReachTheAuthenticatedSignalRClient()
    {
        using var factory = new TestApplicationFactory();
        using var client = factory.CreateClient();
        client.DefaultRequestHeaders.Authorization = new("Bearer", factory.Token);
        await using var connection = new HubConnectionBuilder()
            .WithUrl(
                new Uri(factory.Server.BaseAddress, "/hubs/client"),
                options =>
                {
                    options.HttpMessageHandlerFactory = _ => factory.Server.CreateHandler();
                    options.AccessTokenProvider = () => Task.FromResult<string?>(factory.Token);
                })
            .Build();
        await connection.StartAsync();

        var received = new TaskCompletionSource<OutboxEventEnvelope>(
            TaskCreationOptions.RunContinuationsAsynchronously);
        connection.On<OutboxEventEnvelope>(
            "task.updated",
            envelope => received.TrySetResult(envelope));

        using var conversationRequest = new HttpRequestMessage(HttpMethod.Post, "/api/v1/conversations")
        {
            Content = JsonContent.Create(new { title = "task signalr" })
        };
        conversationRequest.Headers.Add("Idempotency-Key", $"task-signalr-conversation-{Guid.CreateVersion7():N}");
        using var conversationResponse = await client.SendAsync(conversationRequest);
        conversationResponse.EnsureSuccessStatusCode();
        var conversation = await conversationResponse.Content.ReadFromJsonAsync<ConversationResponse>();
        Assert.NotNull(conversation);

        using var taskRequest = new HttpRequestMessage(HttpMethod.Post, "/api/v1/tasks")
        {
            Content = JsonContent.Create(new
            {
                conversationId = conversation.Id,
                sourceMessageIds = Array.Empty<Guid>(),
                goal = "signalr task",
                expectedOutput = "accepted",
                requiredCapabilities = TaskCapabilities
            })
        };
        taskRequest.Headers.Add("Idempotency-Key", $"task-signalr-task-{Guid.CreateVersion7():N}");
        using var taskResponse = await client.SendAsync(taskRequest);
        taskResponse.EnsureSuccessStatusCode();

        var dispatcher = factory.Services.GetRequiredService<OutboxDispatcher>();
        Assert.True(await dispatcher.ProcessOnceAsync() > 0);
        var envelope = await received.Task.WaitAsync(TimeSpan.FromSeconds(5));
        Assert.Equal("task.updated", envelope.Type);
        Assert.NotEqual(Guid.Empty, envelope.EventId);
        var taskPayload = Assert.IsType<JsonElement>(envelope.Payload);
        Assert.True(taskPayload.GetProperty("entityVersion").GetInt64() >= 0);
        await connection.StopAsync();
    }

    [Fact]
    public async Task FakeWorkerTerminalNotificationReachesAuthenticatedSignalRClientWithTaskPayload()
    {
        using var factory = new TestApplicationFactory();
        using var client = factory.CreateClient();
        client.DefaultRequestHeaders.Authorization = new("Bearer", factory.Token);
        var conversationId = await CreateConversationAsync(client, "notification signalr");
        var taskId = await CreateTaskAsync(client, conversationId, "signalr terminal notification");

        await using var connection = new HubConnectionBuilder()
            .WithUrl(
                new Uri(factory.Server.BaseAddress, "/hubs/client"),
                options =>
                {
                    options.HttpMessageHandlerFactory = _ => factory.Server.CreateHandler();
                    options.AccessTokenProvider = () => Task.FromResult<string?>(factory.Token);
                })
            .Build();
        await connection.StartAsync();

        var received = new TaskCompletionSource<OutboxEventEnvelope>(
            TaskCreationOptions.RunContinuationsAsynchronously);
        connection.On<OutboxEventEnvelope>(
            "notification.created",
            envelope => received.TrySetResult(envelope));

        await using (var scope = factory.Services.CreateAsyncScope())
        {
            Assert.True(await scope.ServiceProvider
                .GetRequiredService<FakeDelayWorker>()
                .ProcessOneAsync());
        }

        var dispatcher = factory.Services.GetRequiredService<OutboxDispatcher>();
        Assert.True(await dispatcher.ProcessOnceAsync() > 0);
        var envelope = await received.Task.WaitAsync(TimeSpan.FromSeconds(5));

        Assert.Equal("notification.created", envelope.Type);
        Assert.NotEqual(Guid.Empty, envelope.EventId);
        var payload = Assert.IsType<JsonElement>(envelope.Payload);
        Assert.Equal(taskId, payload.GetProperty("taskId").GetGuid());
        Assert.Equal(conversationId, payload.GetProperty("conversationId").GetGuid());
        Assert.Equal("task.completed", payload.GetProperty("type").GetString());
        Assert.NotEqual(Guid.Empty, payload.GetProperty("notificationId").GetGuid());
        Assert.True(payload.GetProperty("entityVersion").GetInt64() >= 0);
        await connection.StopAsync();
    }

    [Fact]
    public async Task SQLiteRestartKeepsTerminalNotificationsAndNonTerminalTasksAvailableForHttpPull()
    {
        var databasePath = Path.Combine(Path.GetTempPath(), $"jarvis-restart-{Guid.CreateVersion7():N}.db");
        Guid terminalTaskId;
        Guid queuedTaskId;

        using (var firstFactory = new TestApplicationFactory(databasePath, false, null))
        {
            using var client = firstFactory.CreateClient();
            client.DefaultRequestHeaders.Authorization = new("Bearer", firstFactory.Token);
            var conversationId = await CreateConversationAsync(client, "restart pull");
            terminalTaskId = await CreateTaskAsync(client, conversationId, "complete before restart");
            queuedTaskId = await CreateTaskAsync(client, conversationId, "continue after restart");

            await using var scope = firstFactory.Services.CreateAsyncScope();
            Assert.True(await scope.ServiceProvider
                .GetRequiredService<FakeDelayWorker>()
                .ProcessOneAsync());
        }

        using var secondFactory = new TestApplicationFactory(databasePath, true, null);
        using var restartedClient = secondFactory.CreateClient();
        restartedClient.DefaultRequestHeaders.Authorization = new("Bearer", secondFactory.Token);

        var terminal = await restartedClient.GetFromJsonAsync<JsonElement>($"/api/v1/tasks/{terminalTaskId}");
        Assert.Equal("succeeded", terminal.GetProperty("status").GetString());

        var unread = await restartedClient.GetFromJsonAsync<JsonElement>("/api/v1/notifications?status=unread");
        var notification = Assert.Single(unread.GetProperty("items").EnumerateArray());
        Assert.Equal(terminalTaskId, notification.GetProperty("taskId").GetGuid());
        Assert.Equal("task.completed", notification.GetProperty("type").GetString());

        var queued = await restartedClient.GetFromJsonAsync<JsonElement>($"/api/v1/tasks/{queuedTaskId}");
        Assert.Equal("queued", queued.GetProperty("status").GetString());

        var taskList = await restartedClient.GetFromJsonAsync<JsonElement>("/api/v1/tasks?status=queued");
        Assert.Contains(
            taskList.GetProperty("items").EnumerateArray(),
            item => item.GetProperty("id").GetGuid() == queuedTaskId);
    }

    [Fact]
    public async Task SuccessfulPublisherMarksOutboxPublishedAfterDatabaseCommit()
    {
        var publisher = new RecordingPublisher();
        var databasePath = Path.Combine(Path.GetTempPath(), $"jarvis-outbox-success-{Guid.NewGuid():N}.db");
        using var factory = new TestApplicationFactory(databasePath, true, publisher);
        using var client = factory.CreateClient();
        client.DefaultRequestHeaders.Authorization = new("Bearer", factory.Token);
        client.DefaultRequestHeaders.Add("Idempotency-Key", $"outbox-create-{Guid.CreateVersion7():N}");

        var response = await client.PostAsJsonAsync(
            "/api/v1/conversations",
            new { title = "outbox success" },
            new CancellationTokenSource(TimeSpan.FromSeconds(5)).Token);
        response.EnsureSuccessStatusCode();

        var dispatcher = factory.Services.GetRequiredService<OutboxDispatcher>();
        Assert.Equal(1, await dispatcher.ProcessOnceAsync());

        await using var scope = factory.Services.CreateAsyncScope();
        var db = scope.ServiceProvider.GetRequiredService<JarvisDbContext>();
        var message = Assert.Single(db.OutboxMessages);
        Assert.NotNull(message.PublishedAtMs);
        Assert.Equal(0, message.AttemptCount);
        Assert.Single(publisher.Messages);
    }

    [Fact]
    public async Task FailedPublisherRetainsOutboxAndSchedulesRetry()
    {
        var publisher = new FailingPublisher();
        var databasePath = Path.Combine(Path.GetTempPath(), $"jarvis-outbox-failure-{Guid.NewGuid():N}.db");
        using var factory = new TestApplicationFactory(databasePath, true, publisher);
        using var client = factory.CreateClient();
        client.DefaultRequestHeaders.Authorization = new("Bearer", factory.Token);
        client.DefaultRequestHeaders.Add("Idempotency-Key", $"outbox-create-{Guid.CreateVersion7():N}");

        var response = await client.PostAsJsonAsync(
            "/api/v1/conversations",
            new { title = "outbox failure" },
            new CancellationTokenSource(TimeSpan.FromSeconds(5)).Token);
        response.EnsureSuccessStatusCode();

        var dispatcher = factory.Services.GetRequiredService<OutboxDispatcher>();
        Assert.Equal(1, await dispatcher.ProcessOnceAsync());

        await using var scope = factory.Services.CreateAsyncScope();
        var db = scope.ServiceProvider.GetRequiredService<JarvisDbContext>();
        var message = Assert.Single(db.OutboxMessages);
        Assert.Null(message.PublishedAtMs);
        Assert.Equal(1, message.AttemptCount);
        Assert.NotNull(message.NextAttemptAtMs);
        Assert.Contains("publisher unavailable", message.LastError, StringComparison.Ordinal);
    }

    [Fact]
    public async Task OverlappingDispatchersClaimEachEventOnlyOnce()
    {
        var publisher = new BlockingPublisher();
        var databasePath = Path.Combine(Path.GetTempPath(), $"jarvis-outbox-overlap-{Guid.CreateVersion7():N}.db");
        using var factory = new TestApplicationFactory(databasePath, true, publisher);
        using var client = factory.CreateClient();
        client.DefaultRequestHeaders.Authorization = new("Bearer", factory.Token);
        client.DefaultRequestHeaders.Add("Idempotency-Key", $"outbox-overlap-{Guid.CreateVersion7():N}");
        var response = await client.PostAsJsonAsync("/api/v1/conversations", new { title = "overlap" });
        response.EnsureSuccessStatusCode();

        var dispatcher = factory.Services.GetRequiredService<OutboxDispatcher>();
        var first = dispatcher.ProcessOnceAsync();
        await publisher.FirstPublishStarted.WaitAsync(TimeSpan.FromSeconds(5));
        var second = await dispatcher.ProcessOnceAsync();
        publisher.ReleaseFirstPublish();

        Assert.Equal(0, second);
        Assert.Equal(1, await first);
        Assert.Equal(1, publisher.CallCount);
    }

    private sealed class RecordingPublisher : IOutboxPublisher
    {
        public List<Guid> Messages { get; } = [];

        public Task PublishAsync(OutboxMessage message, CancellationToken cancellationToken)
        {
            Messages.Add(message.Id);
            return Task.CompletedTask;
        }
    }

    private sealed class FailingPublisher : IOutboxPublisher
    {
        public Task PublishAsync(OutboxMessage message, CancellationToken cancellationToken)
        {
            throw new InvalidOperationException("publisher unavailable");
        }
    }

    private sealed class BlockingPublisher : IOutboxPublisher
    {
        private readonly TaskCompletionSource _firstPublishStarted = new(
            TaskCreationOptions.RunContinuationsAsynchronously);
        private readonly TaskCompletionSource _release = new(
            TaskCreationOptions.RunContinuationsAsynchronously);
        private int _callCount;

        public Task FirstPublishStarted => _firstPublishStarted.Task;

        public int CallCount => Volatile.Read(ref _callCount);

        public void ReleaseFirstPublish() => _release.TrySetResult();

        public async Task PublishAsync(OutboxMessage message, CancellationToken cancellationToken)
        {
            if (Interlocked.Increment(ref _callCount) == 1)
            {
                _firstPublishStarted.TrySetResult();
                await _release.Task.WaitAsync(cancellationToken);
            }
        }
    }

    private static async Task<Guid> CreateConversationAsync(HttpClient client, string title)
    {
        using var request = new HttpRequestMessage(HttpMethod.Post, "/api/v1/conversations")
        {
            Content = JsonContent.Create(new { title })
        };
        request.Headers.Add("Idempotency-Key", $"outbox-conversation-{Guid.CreateVersion7():N}");
        using var response = await client.SendAsync(request);
        response.EnsureSuccessStatusCode();
        using var document = JsonDocument.Parse(await response.Content.ReadAsStringAsync());
        return document.RootElement.GetProperty("id").GetGuid();
    }

    private static async Task<Guid> CreateTaskAsync(HttpClient client, Guid conversationId, string goal)
    {
        using var request = new HttpRequestMessage(HttpMethod.Post, "/api/v1/tasks")
        {
            Content = JsonContent.Create(new
            {
                conversationId,
                sourceMessageIds = Array.Empty<Guid>(),
                goal,
                expectedOutput = "done",
                requiredCapabilities = TaskCapabilities
            })
        };
        request.Headers.Add("Idempotency-Key", $"outbox-task-{Guid.CreateVersion7():N}");
        using var response = await client.SendAsync(request);
        response.EnsureSuccessStatusCode();
        using var document = JsonDocument.Parse(await response.Content.ReadAsStringAsync());
        return document.RootElement.GetProperty("taskId").GetGuid();
    }
}
