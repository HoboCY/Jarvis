using System.Data.Common;
using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Text.Json;
using Jarvis.Application.Tasks;
using Jarvis.Infrastructure.Data;
using Jarvis.Infrastructure.Tasks;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Diagnostics;
using Microsoft.Extensions.DependencyInjection;
using Xunit;
using DomainTaskStatus = Jarvis.Domain.Tasks.TaskStatus;

namespace Jarvis.Api.IntegrationTests;

public sealed class FakeWorkerTests : IClassFixture<TestApplicationFactory>
{
    private static readonly string[] RequiredCapabilities = ["deepReasoning"];
    private static readonly string[] CancelRaceStatuses = ["succeeded", "cancellationRequested", "cancelled"];
    private readonly TestApplicationFactory factory;

    public FakeWorkerTests(TestApplicationFactory factory)
    {
        this.factory = factory;
    }

    [Fact]
    public async Task SingleWorkerRoundCompletesFromDatabaseAndCreatesDurableNotification()
    {
        using var client = factory.CreateClient();
        client.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", factory.Token);
        var conversationId = await CreateConversationAsync(client);
        using var request = new HttpRequestMessage(HttpMethod.Post, "/api/v1/tasks")
        {
            Content = JsonContent.Create(new
            {
                conversationId,
                sourceMessageIds = Array.Empty<Guid>(),
                goal = "fake work",
                expectedOutput = "fake result",
                requiredCapabilities = RequiredCapabilities
            })
        };
        request.Headers.Add("Idempotency-Key", $"worker-task-{Guid.CreateVersion7():N}");
        using var created = await client.SendAsync(request);
        created.EnsureSuccessStatusCode();
        using var createdJson = JsonDocument.Parse(await created.Content.ReadAsStringAsync());
        var taskId = createdJson.RootElement.GetProperty("taskId").GetGuid();

        await using var scope = factory.Services.CreateAsyncScope();
        var worker = scope.ServiceProvider.GetRequiredService<FakeDelayWorker>();
        Assert.True(await worker.ProcessOneAsync());

        var task = await client.GetFromJsonAsync<JsonElement>($"/api/v1/tasks/{taskId}");
        Assert.Equal("succeeded", task.GetProperty("status").GetString());
        Assert.Contains("fake", task.GetProperty("resultSummary").GetString(), StringComparison.OrdinalIgnoreCase);

        var db = scope.ServiceProvider.GetRequiredService<JarvisDbContext>();
        Assert.Contains(await db.Notifications.ToListAsync(), notification => notification.TaskId == taskId);
        Assert.True(await db.TaskEvents.CountAsync(taskEvent => taskEvent.TaskId == taskId) >= 3);
    }

    [Fact]
    public async Task TaskUpdatedOutboxEntityVersionsRemainMonotonicThroughTerminalState()
    {
        using var client = factory.CreateClient();
        client.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", factory.Token);
        var taskId = await CreateTaskAsync(client, "versioned fake work");

        await using (var workerScope = factory.Services.CreateAsyncScope())
        {
            var worker = workerScope.ServiceProvider.GetRequiredService<FakeDelayWorker>();
            Assert.True(await worker.ProcessOneAsync());
        }

        await using var verificationScope = factory.Services.CreateAsyncScope();
        var db = verificationScope.ServiceProvider.GetRequiredService<JarvisDbContext>();
        var payloads = await db.OutboxMessages
            .AsNoTracking()
            .Where(message => message.EventType == "task.updated"
                && message.PayloadJson.Contains(taskId.ToString()))
            .Select(message => message.PayloadJson)
            .ToListAsync();
        var versions = payloads
            .Select(payload =>
            {
                using var document = JsonDocument.Parse(payload);
                var value = document.RootElement.GetProperty("payload");
                return (
                    EventType: value.GetProperty("eventType").GetString()!,
                    EntityVersion: value.GetProperty("entityVersion").GetInt64());
            })
            .ToDictionary(item => item.EventType, item => item.EntityVersion);

        Assert.True(versions["task.created"] < versions["task.assigned"]);
        Assert.True(versions["task.assigned"] < versions["task.running"]);
        Assert.True(versions["task.running"] < versions["task.progress"]);
        Assert.True(versions["task.progress"] < versions["task.succeeded"]);
        var persistedTask = await db.Tasks.AsNoTracking().SingleAsync(task => task.Id == taskId);
        Assert.Equal(versions["task.succeeded"], persistedTask.Version);
    }

    [Fact]
    public async Task RunningCancellationRemainsRequestedUntilWorkerConfirmsIt()
    {
        using var client = factory.CreateClient();
        client.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", factory.Token);
        var conversationId = await CreateConversationAsync(client);
        using var request = new HttpRequestMessage(HttpMethod.Post, "/api/v1/tasks")
        {
            Content = JsonContent.Create(new
            {
                conversationId,
                sourceMessageIds = Array.Empty<Guid>(),
                goal = "cancel fake work",
                expectedOutput = "never returned",
                requiredCapabilities = RequiredCapabilities
            })
        };
        request.Headers.Add("Idempotency-Key", $"cancel-task-{Guid.CreateVersion7():N}");
        using var created = await client.SendAsync(request);
        created.EnsureSuccessStatusCode();
        using var createdJson = JsonDocument.Parse(await created.Content.ReadAsStringAsync());
        var taskId = createdJson.RootElement.GetProperty("taskId").GetGuid();

        await using var workerScope = factory.Services.CreateAsyncScope();
        var worker = workerScope.ServiceProvider.GetRequiredService<FakeDelayWorker>();
        await using (var setupScope = factory.Services.CreateAsyncScope())
        {
            var db = setupScope.ServiceProvider.GetRequiredService<JarvisDbContext>();
            var task = await db.Tasks.SingleAsync(item => item.Id == taskId);
            var nowMs = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
            task.Assign(worker.WorkerId, nowMs + 60_000, nowMs);
            task.Start(nowMs);
            await db.SaveChangesAsync();
        }

        using var cancel = new HttpRequestMessage(HttpMethod.Post, $"/api/v1/tasks/{taskId}/cancel");
        cancel.Headers.Add("Idempotency-Key", "cancel-task-operation");
        using var cancelResponse = await client.SendAsync(cancel);
        cancelResponse.EnsureSuccessStatusCode();
        var cancellation = await cancelResponse.Content.ReadFromJsonAsync<JsonElement>();
        Assert.Equal("cancellationRequested", cancellation.GetProperty("status").GetString());

        using var beforeWorker = await client.GetAsync($"/api/v1/tasks/{taskId}");
        var beforeWorkerValue = await beforeWorker.Content.ReadFromJsonAsync<JsonElement>();
        Assert.Equal("cancellationRequested", beforeWorkerValue.GetProperty("status").GetString());

        Assert.True(await worker.ProcessOneAsync());

        var afterWorker = await client.GetFromJsonAsync<JsonElement>($"/api/v1/tasks/{taskId}");
        Assert.Equal("cancelled", afterWorker.GetProperty("status").GetString());
    }

    [Fact]
    public async Task WorkerDoesNotExecuteTaskWithAnotherValidLease()
    {
        var adapter = new CountingFakeDelayAdapter();
        using var isolatedFactory = new TestApplicationFactory(
            databasePath: null,
            deleteDatabaseOnDispose: true,
            outboxPublisher: null,
            fakeDelayAdapter: adapter);
        using var client = isolatedFactory.CreateClient();
        client.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", isolatedFactory.Token);
        var taskId = await CreateTaskAsync(client, "external lease");

        await using var workerScope = isolatedFactory.Services.CreateAsyncScope();
        var worker = workerScope.ServiceProvider.GetRequiredService<FakeDelayWorker>();
        await using (var setupScope = isolatedFactory.Services.CreateAsyncScope())
        {
            var db = setupScope.ServiceProvider.GetRequiredService<JarvisDbContext>();
            var task = await db.Tasks.SingleAsync(item => item.Id == taskId);
            var nowMs = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
            var otherDeviceId = await db.Devices.Select(item => item.Id).FirstAsync();
            task.Assign("another-worker", nowMs + 60_000, nowMs, otherDeviceId);
            task.Start(nowMs);
            await db.SaveChangesAsync();
        }

        Assert.False(await worker.ProcessOneAsync());
        Assert.Equal(0, adapter.Calls);
        var taskAfterRound = await client.GetFromJsonAsync<JsonElement>($"/api/v1/tasks/{taskId}");
        Assert.Equal("running", taskAfterRound.GetProperty("status").GetString());
        await using var verificationScope = isolatedFactory.Services.CreateAsyncScope();
        var persistedTask = await verificationScope.ServiceProvider
            .GetRequiredService<JarvisDbContext>()
            .Tasks
            .AsNoTracking()
            .SingleAsync(item => item.Id == taskId);
        Assert.Equal("another-worker", persistedTask.LeaseOwner);
    }

    [Theory]
    [InlineData(null)]
    [InlineData("")]
    [InlineData("   ")]
    public async Task UnconfiguredWorkerExecutesTaskForAnyValidPreferredDevice(string? workerDeviceId)
    {
        var adapter = new CountingFakeDelayAdapter();
        using var isolatedFactory = new TestApplicationFactory(
            databasePath: null,
            deleteDatabaseOnDispose: true,
            outboxPublisher: null,
            fakeDelayAdapter: adapter,
            workerDeviceId: workerDeviceId);
        using var client = isolatedFactory.CreateClient();
        client.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", isolatedFactory.Token);
        await using var deviceScope = isolatedFactory.Services.CreateAsyncScope();
        var preferredDeviceId = await deviceScope.ServiceProvider
            .GetRequiredService<JarvisDbContext>()
            .Devices
            .Select(device => device.Id)
            .FirstAsync();
        var taskId = await CreateTaskAsync(client, "preferred device", preferredDeviceId);

        await using var workerScope = isolatedFactory.Services.CreateAsyncScope();
        Assert.True(await workerScope.ServiceProvider.GetRequiredService<FakeDelayWorker>().ProcessOneAsync());
        Assert.Equal(1, adapter.Calls);
        var task = await client.GetFromJsonAsync<JsonElement>($"/api/v1/tasks/{taskId}");
        Assert.Equal("succeeded", task.GetProperty("status").GetString());
    }

    [Theory]
    [InlineData("not-a-guid")]
    [InlineData("00000000-0000-0000-0000-000000000000")]
    public void InvalidWorkerDeviceIdFailsHostStartup(string workerDeviceId)
    {
        using var invalidFactory = new TestApplicationFactory(
            databasePath: null,
            deleteDatabaseOnDispose: true,
            outboxPublisher: null,
            workerDeviceId: workerDeviceId);

        var exception = Assert.ThrowsAny<Exception>(() => invalidFactory.CreateClient());

        Assert.Contains("WorkerDeviceId", exception.ToString(), StringComparison.Ordinal);
    }

    [Fact]
    public async Task ConfiguredWorkerDoesNotExecuteTaskForMismatchedPreferredDevice()
    {
        var workerDeviceId = Guid.CreateVersion7();
        var adapter = new CountingFakeDelayAdapter();
        using var isolatedFactory = new TestApplicationFactory(
            databasePath: null,
            deleteDatabaseOnDispose: true,
            outboxPublisher: null,
            fakeDelayAdapter: adapter,
            workerDeviceId: workerDeviceId.ToString());
        using var client = isolatedFactory.CreateClient();
        client.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", isolatedFactory.Token);
        await using var deviceScope = isolatedFactory.Services.CreateAsyncScope();
        var preferredDeviceId = await deviceScope.ServiceProvider
            .GetRequiredService<JarvisDbContext>()
            .Devices
            .Select(device => device.Id)
            .FirstAsync();
        Assert.NotEqual(workerDeviceId, preferredDeviceId);
        var taskId = await CreateTaskAsync(client, "mismatched preferred device", preferredDeviceId);

        await using var workerScope = isolatedFactory.Services.CreateAsyncScope();
        Assert.False(await workerScope.ServiceProvider.GetRequiredService<FakeDelayWorker>().ProcessOneAsync());
        Assert.Equal(0, adapter.Calls);
        var task = await client.GetFromJsonAsync<JsonElement>($"/api/v1/tasks/{taskId}");
        Assert.Equal("queued", task.GetProperty("status").GetString());
    }

    [Fact]
    public async Task ConcurrentWorkersExecuteAClaimedTaskOnlyOnce()
    {
        var adapter = new CountingFakeDelayAdapter(blockExecution: true);
        using var isolatedFactory = new TestApplicationFactory(
            databasePath: null,
            deleteDatabaseOnDispose: true,
            outboxPublisher: null,
            fakeDelayAdapter: adapter);
        using var client = isolatedFactory.CreateClient();
        client.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", isolatedFactory.Token);
        var taskId = await CreateTaskAsync(client, "single execution");

        await using var firstScope = isolatedFactory.Services.CreateAsyncScope();
        await using var secondScope = isolatedFactory.Services.CreateAsyncScope();
        var first = firstScope.ServiceProvider.GetRequiredService<FakeDelayWorker>();
        var second = secondScope.ServiceProvider.GetRequiredService<FakeDelayWorker>();
        var firstRound = first.ProcessOneAsync();
        var secondRound = second.ProcessOneAsync();
        await adapter.Started.Task.WaitAsync(TimeSpan.FromSeconds(5));
        adapter.Release.TrySetResult(true);
        var rounds = await Task.WhenAll(firstRound, secondRound);

        Assert.Contains(true, rounds);
        Assert.Equal(1, adapter.Calls);
        var task = await client.GetFromJsonAsync<JsonElement>($"/api/v1/tasks/{taskId}");
        Assert.Equal("succeeded", task.GetProperty("status").GetString());
    }

    [Fact]
    public async Task ExpiredAssignedAndRunningLeasesRecoverBeforeExecution()
    {
        var adapter = new CountingFakeDelayAdapter();
        using var isolatedFactory = new TestApplicationFactory(
            databasePath: null,
            deleteDatabaseOnDispose: true,
            outboxPublisher: null,
            fakeDelayAdapter: adapter);
        using var client = isolatedFactory.CreateClient();
        client.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", isolatedFactory.Token);
        var assignedTaskId = await CreateTaskAsync(client, "expired assigned");
        var runningTaskId = await CreateTaskAsync(client, "expired running");

        await using var workerScope = isolatedFactory.Services.CreateAsyncScope();
        var worker = workerScope.ServiceProvider.GetRequiredService<FakeDelayWorker>();
        await using (var setupScope = isolatedFactory.Services.CreateAsyncScope())
        {
            var db = setupScope.ServiceProvider.GetRequiredService<JarvisDbContext>();
            var nowMs = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
            var assigned = await db.Tasks.SingleAsync(item => item.Id == assignedTaskId);
            assigned.Assign("expired-worker", nowMs - 1, nowMs - 2);
            var running = await db.Tasks.SingleAsync(item => item.Id == runningTaskId);
            running.Assign("expired-worker", nowMs - 1, nowMs - 2);
            running.Start(nowMs - 1);
            await db.SaveChangesAsync();
        }

        Assert.True(await worker.ProcessOneAsync());
        Assert.True(await worker.ProcessOneAsync());
        Assert.Equal(2, adapter.Calls);

        await using var verificationScope = isolatedFactory.Services.CreateAsyncScope();
        var verificationDb = verificationScope.ServiceProvider.GetRequiredService<JarvisDbContext>();
        foreach (var taskId in new[] { assignedTaskId, runningTaskId })
        {
            var task = await verificationDb.Tasks.AsNoTracking().SingleAsync(item => item.Id == taskId);
            Assert.Equal(DomainTaskStatus.Succeeded, task.Status);
            var eventTypes = await verificationDb.TaskEvents
                .Where(item => item.TaskId == taskId)
                .Select(item => item.EventType)
                .ToListAsync();
            Assert.Contains("task.recovering", eventTypes);
            Assert.Contains("task.assigned", eventTypes);
            Assert.Contains("task.running", eventTypes);
        }
    }

    [Fact]
    public async Task RunningWorkerRenewsLeaseAcrossMultipleLeasePeriodsBeforeCompleting()
    {
        var clock = new AdvancingTimeProvider(new DateTimeOffset(2030, 1, 2, 3, 4, 5, TimeSpan.Zero));
        var adapter = new CountingFakeDelayAdapter(blockExecution: true);
        using var isolatedFactory = new TestApplicationFactory(
            databasePath: null,
            deleteDatabaseOnDispose: true,
            outboxPublisher: null,
            timeProvider: clock,
            fakeDelayAdapter: adapter);
        using var client = isolatedFactory.CreateClient();
        client.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", isolatedFactory.Token);
        var taskId = await CreateTaskAsync(client, "lease boundary");

        await using var firstScope = isolatedFactory.Services.CreateAsyncScope();
        await using var secondScope = isolatedFactory.Services.CreateAsyncScope();
        var first = firstScope.ServiceProvider.GetRequiredService<FakeDelayWorker>();
        var second = secondScope.ServiceProvider.GetRequiredService<FakeDelayWorker>();
        var firstRound = first.ProcessOneAsync();
        await adapter.Started.Task.WaitAsync(TimeSpan.FromSeconds(5));
        await using var artifactScope = isolatedFactory.Services.CreateAsyncScope();
        var artifactDb = artifactScope.ServiceProvider.GetRequiredService<JarvisDbContext>();
        var initialTaskEventCount = await artifactDb.TaskEvents.CountAsync(item => item.TaskId == taskId);
        var initialOutboxCount = await artifactDb.OutboxMessages.CountAsync();

        clock.Advance(TimeSpan.FromMilliseconds(FakeDelayOptions.LeaseDurationMs / 2));
        await WaitForLeaseHeartbeatAsync(isolatedFactory, taskId, clock.UnixNowMs);
        Assert.False(await second.ProcessOneAsync());
        Assert.Equal(1, adapter.Calls);

        clock.Advance(TimeSpan.FromMilliseconds(FakeDelayOptions.LeaseDurationMs / 2));
        await WaitForLeaseHeartbeatAsync(isolatedFactory, taskId, clock.UnixNowMs);
        Assert.False(await second.ProcessOneAsync());
        Assert.Equal(1, adapter.Calls);

        Assert.Equal(initialTaskEventCount, await artifactDb.TaskEvents.CountAsync(item => item.TaskId == taskId));
        Assert.Equal(initialOutboxCount, await artifactDb.OutboxMessages.CountAsync());

        adapter.Release.TrySetResult(true);
        await firstRound;

        var task = await client.GetFromJsonAsync<JsonElement>($"/api/v1/tasks/{taskId}");
        Assert.Equal("succeeded", task.GetProperty("status").GetString());
    }

    [Fact]
    public async Task ExpiredWorkerCannotPersistCompletionAfterLeaseFencing()
    {
        var clock = new AdvancingTimeProvider(new DateTimeOffset(2030, 1, 2, 3, 4, 5, TimeSpan.Zero));
        var adapter = new IgnoresCancellationFakeDelayAdapter();
        using var isolatedFactory = new TestApplicationFactory(
            databasePath: null,
            deleteDatabaseOnDispose: true,
            outboxPublisher: null,
            timeProvider: clock,
            fakeDelayAdapter: adapter);
        using var client = isolatedFactory.CreateClient();
        client.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", isolatedFactory.Token);
        var taskId = await CreateTaskAsync(client, "expired completion fencing");

        await using var workerScope = isolatedFactory.Services.CreateAsyncScope();
        var worker = workerScope.ServiceProvider.GetRequiredService<FakeDelayWorker>();
        var workerRound = worker.ProcessOneAsync();
        await adapter.Started.Task.WaitAsync(TimeSpan.FromSeconds(5));

        clock.Advance(TimeSpan.FromMilliseconds(FakeDelayOptions.LeaseDurationMs + 1));
        await Task.Delay(50);
        adapter.Release.TrySetResult(true);
        Assert.True(await workerRound);

        var task = await client.GetFromJsonAsync<JsonElement>($"/api/v1/tasks/{taskId}");
        Assert.Equal("running", task.GetProperty("status").GetString());
        Assert.False(task.TryGetProperty("resultSummary", out var resultSummary)
            && resultSummary.ValueKind is not JsonValueKind.Null);
    }

    [Fact]
    public async Task RenewalFailureCancelsAdapterAndDoesNotPersistItsSuccessfulResult()
    {
        var interceptor = new ThrowOnArmedTaskUpdateInterceptor();
        var adapter = new CountingFakeDelayAdapter(blockExecution: true);
        using var isolatedFactory = new TestApplicationFactory(
            databasePath: null,
            deleteDatabaseOnDispose: true,
            outboxPublisher: null,
            dbCommandInterceptor: interceptor,
            fakeDelayAdapter: adapter);
        using var client = isolatedFactory.CreateClient();
        client.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", isolatedFactory.Token);
        var taskId = await CreateTaskAsync(client, "renewal failure");

        await using var workerScope = isolatedFactory.Services.CreateAsyncScope();
        var worker = workerScope.ServiceProvider.GetRequiredService<FakeDelayWorker>();
        var workerRound = worker.ProcessOneAsync();
        await adapter.Started.Task.WaitAsync(TimeSpan.FromSeconds(5));
        interceptor.Arm();

        Assert.True(await workerRound.WaitAsync(TimeSpan.FromSeconds(5)));
        Assert.True(interceptor.HasThrown);
        Assert.Equal(1, adapter.Calls);

        var task = await client.GetFromJsonAsync<JsonElement>($"/api/v1/tasks/{taskId}");
        Assert.Equal("running", task.GetProperty("status").GetString());
        Assert.False(task.TryGetProperty("resultSummary", out var resultSummary)
            && resultSummary.ValueKind is not JsonValueKind.Null);

        await using var secondScope = isolatedFactory.Services.CreateAsyncScope();
        Assert.False(await secondScope.ServiceProvider.GetRequiredService<FakeDelayWorker>().ProcessOneAsync());
        Assert.Equal(1, adapter.Calls);
    }

    [Fact]
    public async Task CancellationRequestedStopsBlockedAdapterAndConfirmsCancellation()
    {
        var adapter = new CountingFakeDelayAdapter(blockExecution: true);
        using var isolatedFactory = new TestApplicationFactory(
            databasePath: null,
            deleteDatabaseOnDispose: true,
            outboxPublisher: null,
            fakeDelayAdapter: adapter);
        using var client = isolatedFactory.CreateClient();
        client.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", isolatedFactory.Token);
        var taskId = await CreateTaskAsync(client, "cancel blocked fake work");

        await using var workerScope = isolatedFactory.Services.CreateAsyncScope();
        var worker = workerScope.ServiceProvider.GetRequiredService<FakeDelayWorker>();
        var workerRound = worker.ProcessOneAsync();
        await adapter.Started.Task.WaitAsync(TimeSpan.FromSeconds(5));

        using var cancel = new HttpRequestMessage(HttpMethod.Post, $"/api/v1/tasks/{taskId}/cancel");
        cancel.Headers.Add("Idempotency-Key", $"cancel-blocked-{Guid.CreateVersion7():N}");
        using var cancelResponse = await client.SendAsync(cancel);
        cancelResponse.EnsureSuccessStatusCode();
        var cancellation = await cancelResponse.Content.ReadFromJsonAsync<JsonElement>();
        Assert.Equal("cancellationRequested", cancellation.GetProperty("status").GetString());

        Assert.True(await workerRound);
        Assert.Equal(1, adapter.Calls);
        var task = await client.GetFromJsonAsync<JsonElement>($"/api/v1/tasks/{taskId}");
        Assert.Equal("cancelled", task.GetProperty("status").GetString());
    }

    [Fact]
    public async Task CancelAndWorkerTerminalRaceReturnsConflictOrCancellationWithoutServerError()
    {
        var adapter = new CountingFakeDelayAdapter(blockExecution: true);
        using var isolatedFactory = new TestApplicationFactory(
            databasePath: null,
            deleteDatabaseOnDispose: true,
            outboxPublisher: null,
            fakeDelayAdapter: adapter);
        using var client = isolatedFactory.CreateClient();
        client.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", isolatedFactory.Token);
        var taskId = await CreateTaskAsync(client, "cancel terminal race");

        await using var workerScope = isolatedFactory.Services.CreateAsyncScope();
        var worker = workerScope.ServiceProvider.GetRequiredService<FakeDelayWorker>();
        var workerRound = worker.ProcessOneAsync();
        await adapter.Started.Task.WaitAsync(TimeSpan.FromSeconds(5));

        using var cancel = new HttpRequestMessage(HttpMethod.Post, $"/api/v1/tasks/{taskId}/cancel");
        cancel.Headers.Add("Idempotency-Key", $"cancel-race-{Guid.CreateVersion7():N}");
        var cancelRound = client.SendAsync(cancel);
        adapter.Release.TrySetResult(true);
        using var cancelResponse = await cancelRound;
        Assert.True(
            cancelResponse.StatusCode is HttpStatusCode.OK or HttpStatusCode.Conflict,
            $"Unexpected cancellation response: {(int)cancelResponse.StatusCode}");
        await workerRound;

        var task = await client.GetFromJsonAsync<JsonElement>($"/api/v1/tasks/{taskId}");
        Assert.Contains(
            task.GetProperty("status").GetString(),
            CancelRaceStatuses);
    }

    [Fact]
    public async Task ExternalCancellationPropagatesAndLeavesRunningTaskDurable()
    {
        var adapter = new CountingFakeDelayAdapter(blockExecution: true);
        using var isolatedFactory = new TestApplicationFactory(
            databasePath: null,
            deleteDatabaseOnDispose: true,
            outboxPublisher: null,
            fakeDelayAdapter: adapter);
        using var client = isolatedFactory.CreateClient();
        client.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", isolatedFactory.Token);
        var taskId = await CreateTaskAsync(client, "stop worker host");

        await using var workerScope = isolatedFactory.Services.CreateAsyncScope();
        var worker = workerScope.ServiceProvider.GetRequiredService<FakeDelayWorker>();
        using var cancellation = new CancellationTokenSource();
        var workerRound = worker.ProcessOneAsync(cancellation.Token);
        await adapter.Started.Task.WaitAsync(TimeSpan.FromSeconds(5));
        cancellation.Cancel();

        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => workerRound);
        Assert.Equal(1, adapter.Calls);
        var task = await client.GetFromJsonAsync<JsonElement>($"/api/v1/tasks/{taskId}");
        Assert.Equal("running", task.GetProperty("status").GetString());
    }

    [Theory]
    [InlineData(DomainTaskStatus.Assigned)]
    [InlineData(DomainTaskStatus.Running)]
    [InlineData(DomainTaskStatus.Recovering)]
    public async Task MaxAttemptRecoveryFailsWithoutExecutingAndWritesTerminalArtifacts(DomainTaskStatus finalStatus)
    {
        var adapter = new CountingFakeDelayAdapter();
        using var isolatedFactory = new TestApplicationFactory(
            databasePath: null,
            deleteDatabaseOnDispose: true,
            outboxPublisher: null,
            fakeDelayAdapter: adapter);
        using var client = isolatedFactory.CreateClient();
        client.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", isolatedFactory.Token);
        var taskId = await CreateTaskAsync(client, $"max attempts {finalStatus}");
        await SetTaskAttemptsAsync(isolatedFactory, taskId, attempts: 3, finalStatus);

        await using var workerScope = isolatedFactory.Services.CreateAsyncScope();
        var worker = workerScope.ServiceProvider.GetRequiredService<FakeDelayWorker>();
        Assert.True(await worker.ProcessOneAsync());
        Assert.Equal(0, adapter.Calls);

        await using var verificationScope = isolatedFactory.Services.CreateAsyncScope();
        var db = verificationScope.ServiceProvider.GetRequiredService<JarvisDbContext>();
        var task = await db.Tasks.AsNoTracking().SingleAsync(item => item.Id == taskId);
        Assert.Equal(DomainTaskStatus.Failed, task.Status);
        Assert.Equal(3, task.Attempt);
        Assert.Equal("fake_worker_max_attempts_exceeded", task.ErrorCode);
        Assert.Null(task.LeaseOwner);
        Assert.Null(task.LeaseExpiresAtMs);

        var eventTypes = await db.TaskEvents
            .Where(item => item.TaskId == taskId)
            .Select(item => item.EventType)
            .ToListAsync();
        Assert.Contains("task.failed", eventTypes);
        if (finalStatus is DomainTaskStatus.Assigned or DomainTaskStatus.Running)
        {
            Assert.Contains("task.recovering", eventTypes);
        }

        var notification = Assert.Single(await db.Notifications
            .Where(item => item.TaskId == taskId)
            .ToListAsync());
        Assert.Equal("task.failed", notification.Type);
        var outboxTypes = await db.OutboxMessages
            .Where(item => item.PayloadJson.Contains(taskId.ToString()))
            .Select(item => item.EventType)
            .ToListAsync();
        Assert.Contains("task.updated", outboxTypes);
        Assert.Contains("notification.created", outboxTypes);
    }

    [Fact]
    public async Task RecoveringBelowMaxAttemptsIsReassignedAndExecuted()
    {
        var adapter = new CountingFakeDelayAdapter();
        using var isolatedFactory = new TestApplicationFactory(
            databasePath: null,
            deleteDatabaseOnDispose: true,
            outboxPublisher: null,
            fakeDelayAdapter: adapter);
        using var client = isolatedFactory.CreateClient();
        client.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", isolatedFactory.Token);
        var taskId = await CreateTaskAsync(client, "recover under max attempts");
        await SetTaskAttemptsAsync(isolatedFactory, taskId, attempts: 2, DomainTaskStatus.Recovering);

        await using var workerScope = isolatedFactory.Services.CreateAsyncScope();
        var worker = workerScope.ServiceProvider.GetRequiredService<FakeDelayWorker>();
        Assert.True(await worker.ProcessOneAsync());
        Assert.Equal(1, adapter.Calls);

        var task = await client.GetFromJsonAsync<JsonElement>($"/api/v1/tasks/{taskId}");
        Assert.Equal("succeeded", task.GetProperty("status").GetString());
    }

    private static async Task<Guid> CreateConversationAsync(HttpClient client)
    {
        using var request = new HttpRequestMessage(HttpMethod.Post, "/api/v1/conversations")
        {
            Content = JsonContent.Create(new { title = "Fake worker" })
        };
        request.Headers.Add("Idempotency-Key", $"conversation-worker-{Guid.CreateVersion7():N}");
        using var response = await client.SendAsync(request);
        response.EnsureSuccessStatusCode();
        using var document = JsonDocument.Parse(await response.Content.ReadAsStringAsync());
        return document.RootElement.GetProperty("id").GetGuid();
    }

    private static async Task<Guid> CreateTaskAsync(HttpClient client, string goal, Guid? preferredDeviceId = null)
    {
        var conversationId = await CreateConversationAsync(client);
        using var request = new HttpRequestMessage(HttpMethod.Post, "/api/v1/tasks")
        {
            Content = JsonContent.Create(new
            {
                conversationId,
                sourceMessageIds = Array.Empty<Guid>(),
                goal,
                expectedOutput = "fake result",
                requiredCapabilities = RequiredCapabilities,
                preferredDeviceId
            })
        };
        request.Headers.Add("Idempotency-Key", $"worker-task-{Guid.CreateVersion7():N}");
        using var response = await client.SendAsync(request);
        response.EnsureSuccessStatusCode();
        using var document = JsonDocument.Parse(await response.Content.ReadAsStringAsync());
        return document.RootElement.GetProperty("taskId").GetGuid();
    }

    private static async Task SetTaskAttemptsAsync(
        TestApplicationFactory factory,
        Guid taskId,
        int attempts,
        DomainTaskStatus finalStatus)
    {
        await using var scope = factory.Services.CreateAsyncScope();
        var db = scope.ServiceProvider.GetRequiredService<JarvisDbContext>();
        var task = await db.Tasks.SingleAsync(item => item.Id == taskId);
        var nowMs = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        for (var attempt = 0; attempt < attempts; attempt++)
        {
            task.Assign($"expired-worker-{attempt}", nowMs - 1, nowMs - 2);
            if (attempt < attempts - 1)
            {
                task.MarkRecovering(nowMs - 2);
            }
        }

        switch (finalStatus)
        {
            case DomainTaskStatus.Assigned:
                break;
            case DomainTaskStatus.Running:
                task.Start(nowMs - 1);
                break;
            case DomainTaskStatus.Recovering:
                task.MarkRecovering(nowMs);
                break;
            default:
                throw new ArgumentOutOfRangeException(nameof(finalStatus), finalStatus, null);
        }

        await db.SaveChangesAsync();
    }

    private static async Task WaitForLeaseHeartbeatAsync(
        TestApplicationFactory factory,
        Guid taskId,
        long minimumHeartbeatMs)
    {
        for (var attempt = 0; attempt < 200; attempt++)
        {
            await using var scope = factory.Services.CreateAsyncScope();
            var db = scope.ServiceProvider.GetRequiredService<JarvisDbContext>();
            var task = await db.Tasks.AsNoTracking().SingleAsync(item => item.Id == taskId);
            if (task.HeartbeatAtMs >= minimumHeartbeatMs)
            {
                return;
            }

            await Task.Delay(25);
        }

        throw new Xunit.Sdk.XunitException($"Task {taskId} was not renewed at {minimumHeartbeatMs}.");
    }

    private sealed class CountingFakeDelayAdapter(
        bool blockExecution = false) : IFakeDelayAdapter
    {
        private readonly bool blockExecution = blockExecution;
        private int callCount;
        public TaskCompletionSource<bool> Started { get; } = new(TaskCreationOptions.RunContinuationsAsynchronously);
        public TaskCompletionSource<bool> Release { get; } = new(TaskCreationOptions.RunContinuationsAsynchronously);
        public int Calls => Volatile.Read(ref callCount);

        public async Task<FakeWorkResult> ExecuteAsync(FakeWorkItem workItem, CancellationToken cancellationToken)
        {
            Interlocked.Increment(ref callCount);
            Started.TrySetResult(true);
            if (blockExecution)
            {
                await Release.Task.WaitAsync(cancellationToken);
            }

            return new(true, $"fake result for {workItem.Goal}");
        }
    }

    private sealed class IgnoresCancellationFakeDelayAdapter : IFakeDelayAdapter
    {
        public TaskCompletionSource<bool> Started { get; } = new(TaskCreationOptions.RunContinuationsAsynchronously);
        public TaskCompletionSource<bool> Release { get; } = new(TaskCreationOptions.RunContinuationsAsynchronously);

        public async Task<FakeWorkResult> ExecuteAsync(FakeWorkItem workItem, CancellationToken cancellationToken)
        {
            Started.TrySetResult(true);
            await Release.Task;
            return new(true, $"fake result for {workItem.Goal}");
        }
    }

    private sealed class AdvancingTimeProvider(DateTimeOffset initial) : TimeProvider
    {
        private DateTimeOffset now = initial;

        public override DateTimeOffset GetUtcNow() => now;

        public long UnixNowMs => now.ToUnixTimeMilliseconds();

        public void Advance(TimeSpan duration) => now += duration;
    }

    private sealed class ThrowOnArmedTaskUpdateInterceptor : DbCommandInterceptor
    {
        private int armed;
        private int thrown;

        public bool HasThrown => Volatile.Read(ref thrown) == 1;

        public void Arm() => Volatile.Write(ref armed, 1);

        public override InterceptionResult<int> NonQueryExecuting(
            DbCommand command,
            CommandEventData eventData,
            InterceptionResult<int> result)
        {
            ThrowIfArmed(command);
            return result;
        }

        public override ValueTask<InterceptionResult<int>> NonQueryExecutingAsync(
            DbCommand command,
            CommandEventData eventData,
            InterceptionResult<int> result,
            CancellationToken cancellationToken = default)
        {
            ThrowIfArmed(command);
            return ValueTask.FromResult(result);
        }

        public override InterceptionResult<DbDataReader> ReaderExecuting(
            DbCommand command,
            CommandEventData eventData,
            InterceptionResult<DbDataReader> result)
        {
            ThrowIfArmed(command);
            return result;
        }

        public override ValueTask<InterceptionResult<DbDataReader>> ReaderExecutingAsync(
            DbCommand command,
            CommandEventData eventData,
            InterceptionResult<DbDataReader> result,
            CancellationToken cancellationToken = default)
        {
            ThrowIfArmed(command);
            return ValueTask.FromResult(result);
        }

        private void ThrowIfArmed(DbCommand command)
        {
            if (Volatile.Read(ref armed) == 1
                && command.CommandText.Contains("UPDATE \"Tasks\"", StringComparison.Ordinal)
                && Interlocked.Exchange(ref thrown, 1) == 0)
            {
                throw new InvalidOperationException("Injected unknown renewal failure.");
            }
        }
    }
}
