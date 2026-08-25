using System.Net.Http.Json;
using Jarvis.Application.Outbox;
using Jarvis.Contracts;
using Jarvis.Infrastructure.Data;
using Jarvis.Infrastructure.Outbox;
using Jarvis.Domain.Outbox;
using Microsoft.AspNetCore.SignalR.Client;
using Microsoft.Extensions.DependencyInjection;
using Xunit;

namespace Jarvis.Api.IntegrationTests;

public sealed class OutboxTests
{
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
}
