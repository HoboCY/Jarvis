using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Text.Json;
using Jarvis.Application.Responses;
using Jarvis.Infrastructure.Data;
using Jarvis.Infrastructure.Tasks;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Xunit;

namespace Jarvis.Api.IntegrationTests;

public sealed class Phase5ResponsesWorkerTests
{
    private static readonly string[] DeepReasoningCapabilities = ["deepReasoning"];

    [Fact]
    public async Task ResponsesTaskCompletesWithoutADeviceAndPersistsExternalResponseId()
    {
        var runtime = new ScriptedResponsesRuntime();
        using var factory = new TestApplicationFactory(
            null,
            true,
            null,
            null,
            null,
            null,
            null,
            null,
            runtime);
        using var client = factory.CreateClient();
        client.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", factory.Token);
        var conversationId = await CreateConversationAsync(client);
        using var create = new HttpRequestMessage(HttpMethod.Post, "/api/v1/tasks")
        {
            Content = JsonContent.Create(new
            {
                conversationId,
                sourceMessageIds = Array.Empty<Guid>(),
                goal = "总结这段文本",
                expectedOutput = "简洁总结",
                requiredCapabilities = DeepReasoningCapabilities
            })
        };
        create.Headers.Add("Idempotency-Key", $"responses-task-{Guid.CreateVersion7():N}");
        using var created = await client.SendAsync(create);
        created.EnsureSuccessStatusCode();
        var taskId = (await created.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("taskId").GetGuid();

        await using var cleanupScope = factory.Services.CreateAsyncScope();
        var cleanupDb = cleanupScope.ServiceProvider.GetRequiredService<JarvisDbContext>();
        cleanupDb.Devices.RemoveRange(cleanupDb.Devices);
        await cleanupDb.SaveChangesAsync();

        await using var scope = factory.Services.CreateAsyncScope();
        var worker = scope.ServiceProvider.GetRequiredService<ResponsesWorker>();
        Assert.True(await worker.ProcessOneAsync());

        var task = await client.GetFromJsonAsync<JsonElement>($"/api/v1/tasks/{taskId}");
        Assert.Equal("succeeded", task.GetProperty("status").GetString());
        Assert.Equal("resp_test_1", task.GetProperty("execution").GetProperty("externalExecutionId").GetString());
        Assert.Null(task.GetProperty("execution").GetProperty("deviceId").GetString());
        Assert.Equal(1, runtime.CreateCalls);
        var outbox = await scope.ServiceProvider.GetRequiredService<JarvisDbContext>().OutboxMessages
            .Select(message => new { message.EventType, message.PayloadJson })
            .ToListAsync();
        Assert.Contains(outbox, message =>
            message.EventType == "task.updated"
            && message.PayloadJson.Contains(taskId.ToString(), StringComparison.Ordinal));
        Assert.Empty(await scope.ServiceProvider.GetRequiredService<JarvisDbContext>().Devices.ToListAsync());
    }

    [Theory]
    [InlineData(ResponsesStatus.Failed, "provider_failed", "responses_failed", "The Responses provider failed to complete the task.")]
    [InlineData(ResponsesStatus.Incomplete, "provider_incomplete", "responses_incomplete", "The Responses provider returned an incomplete result.")]
    [InlineData(ResponsesStatus.Unknown, "provider_unknown", "responses_unknown_status", "The Responses provider returned an unknown status.")]
    public async Task ProviderTerminalFailuresFailClosedWithoutPersistingRawDiagnostics(
        ResponsesStatus providerStatus,
        string providerCode,
        string expectedErrorCode,
        string expectedMessage)
    {
        var runtime = new TerminalFailureResponsesRuntime(providerStatus, providerCode, "provider secret diagnostics");
        using var factory = new TestApplicationFactory(null, true, null, null, null, null, null, null, runtime);
        using var client = factory.CreateClient();
        client.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", factory.Token);
        var conversationId = await CreateConversationAsync(client);
        var taskId = await CreateResponsesTaskAsync(client, conversationId);

        await using var scope = factory.Services.CreateAsyncScope();
        Assert.True(await scope.ServiceProvider.GetRequiredService<ResponsesWorker>().ProcessOneAsync());

        var task = await client.GetFromJsonAsync<JsonElement>($"/api/v1/tasks/{taskId}");
        Assert.Equal("failed", task.GetProperty("status").GetString());
        Assert.Equal(expectedErrorCode, task.GetProperty("errorCode").GetString());
        Assert.Equal(expectedMessage, task.GetProperty("errorMessage").GetString());
        Assert.DoesNotContain("provider secret diagnostics", task.GetProperty("errorMessage").GetString(), StringComparison.Ordinal);
        Assert.Equal("resp_terminal", task.GetProperty("execution").GetProperty("externalExecutionId").GetString());

        var db = scope.ServiceProvider.GetRequiredService<JarvisDbContext>();
        var persisted = await db.TaskEvents
            .Where(item => item.TaskId == taskId)
            .Select(item => item.PayloadJson)
            .ToListAsync();
        var outbox = (await db.OutboxMessages
            .Select(item => item.PayloadJson)
            .ToListAsync())
            .Where(value => value.Contains(taskId.ToString(), StringComparison.Ordinal))
            .ToArray();
        var notifications = await db.Notifications
            .Where(item => item.TaskId == taskId)
            .Select(item => item.Body)
            .ToListAsync();
        Assert.DoesNotContain(persisted, value => value.Contains("provider secret diagnostics", StringComparison.Ordinal));
        Assert.DoesNotContain(outbox, value => value.Contains("provider secret diagnostics", StringComparison.Ordinal));
        Assert.DoesNotContain(notifications, value => value.Contains("provider secret diagnostics", StringComparison.Ordinal));
    }

    [Fact]
    public async Task CancellationCallsProviderAndPersistsCancelledTerminalState()
    {
        var runtime = new QueueThenCancelResponsesRuntime();
        using var factory = new TestApplicationFactory(null, true, null, null, null, null, null, null, runtime);
        using var client = factory.CreateClient();
        client.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", factory.Token);
        var conversationId = await CreateConversationAsync(client);
        var taskId = await CreateResponsesTaskAsync(client, conversationId);

        await using (var firstScope = factory.Services.CreateAsyncScope())
        {
            Assert.True(await firstScope.ServiceProvider.GetRequiredService<ResponsesWorker>().ProcessOneAsync());
        }

        using var cancel = new HttpRequestMessage(HttpMethod.Post, $"/api/v1/tasks/{taskId}/cancel");
        cancel.Headers.Add("Idempotency-Key", "responses-cancel");
        using var cancelled = await client.SendAsync(cancel);
        cancelled.EnsureSuccessStatusCode();

        await using (var secondScope = factory.Services.CreateAsyncScope())
        {
            Assert.True(await secondScope.ServiceProvider.GetRequiredService<ResponsesWorker>().ProcessOneAsync());
        }

        var task = await client.GetFromJsonAsync<JsonElement>($"/api/v1/tasks/{taskId}");
        Assert.Equal("cancelled", task.GetProperty("status").GetString());
        Assert.Equal(1, runtime.CancelCalls);
        Assert.Equal(1, runtime.CreateCalls);
    }

    [Fact]
    public async Task ExpiredLeaseRecoversExistingExternalResponseWithoutCreatingAgain()
    {
        var clock = new AdvancingTimeProvider(new DateTimeOffset(2030, 1, 1, 0, 0, 0, TimeSpan.Zero));
        var runtime = new ExpiredLeaseResponsesRuntime();
        using var factory = new TestApplicationFactory(null, true, null, clock, null, null, null, null, runtime);
        using var client = factory.CreateClient();
        client.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", factory.Token);
        var conversationId = await CreateConversationAsync(client);
        var taskId = await CreateResponsesTaskAsync(client, conversationId);

        await using (var firstScope = factory.Services.CreateAsyncScope())
        {
            Assert.True(await firstScope.ServiceProvider.GetRequiredService<ResponsesWorker>().ProcessOneAsync());
        }

        clock.Advance(TimeSpan.FromMilliseconds(65_002));
        await using (var secondScope = factory.Services.CreateAsyncScope())
        {
            Assert.True(await secondScope.ServiceProvider.GetRequiredService<ResponsesWorker>().ProcessOneAsync());
        }

        var task = await client.GetFromJsonAsync<JsonElement>($"/api/v1/tasks/{taskId}");
        Assert.Equal("succeeded", task.GetProperty("status").GetString());
        Assert.Equal("resp_expired", task.GetProperty("execution").GetProperty("externalExecutionId").GetString());
        Assert.Equal(1, runtime.CreateCalls);
        Assert.Equal(1, runtime.RetrieveCalls);

        await using var verificationScope = factory.Services.CreateAsyncScope();
        var db = verificationScope.ServiceProvider.GetRequiredService<JarvisDbContext>();
        Assert.Contains(await db.TaskEvents.Where(item => item.TaskId == taskId).Select(item => item.EventType).ToListAsync(), eventType => eventType == "task.recovering");
    }

    [Fact]
    public async Task ValidForeignLeaseIsFencedWithoutCallingProvider()
    {
        var runtime = new ScriptedResponsesRuntime();
        using var factory = new TestApplicationFactory(null, true, null, null, null, null, null, null, runtime);
        using var client = factory.CreateClient();
        client.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", factory.Token);
        var conversationId = await CreateConversationAsync(client);
        var taskId = await CreateResponsesTaskAsync(client, conversationId);
        await using (var seedScope = factory.Services.CreateAsyncScope())
        {
            var db = seedScope.ServiceProvider.GetRequiredService<JarvisDbContext>();
            var task = await db.Tasks.SingleAsync(item => item.Id == taskId);
            var nowMs = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
            task.Assign("foreign-worker", nowMs + 60_000, nowMs);
            task.Start(nowMs);
            var execution = Jarvis.Domain.Tasks.TaskExecution.Create(
                Guid.CreateVersion7(), task.Id, null, Jarvis.Domain.Tasks.WorkerKind.Responses, nowMs);
            execution.Start(nowMs);
            execution.SetExternalExecutionId("resp_foreign");
            db.TaskExecutions.Add(execution);
            await db.SaveChangesAsync();
        }

        await using (var workerScope = factory.Services.CreateAsyncScope())
        {
            Assert.False(await workerScope.ServiceProvider.GetRequiredService<ResponsesWorker>().ProcessOneAsync());
        }

        Assert.Equal(0, runtime.CreateCalls);
        await using var verificationScope = factory.Services.CreateAsyncScope();
        var persisted = await verificationScope.ServiceProvider.GetRequiredService<JarvisDbContext>().Tasks.SingleAsync(item => item.Id == taskId);
        Assert.Equal(Jarvis.Domain.Tasks.TaskStatus.Running, persisted.Status);
        Assert.Equal("foreign-worker", persisted.LeaseOwner);
    }

    [Fact]
    public async Task ANewScopeReusesTheWorkerLeaseAndPollsAnExistingResponseWithoutCreatingAgain()
    {
        var runtime = new QueueThenCompleteResponsesRuntime();
        using var factory = new TestApplicationFactory(
            null,
            true,
            null,
            null,
            null,
            null,
            null,
            null,
            runtime);
        using var client = factory.CreateClient();
        client.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", factory.Token);
        var conversationId = await CreateConversationAsync(client);
        var taskId = await CreateResponsesTaskAsync(client, conversationId);

        string firstWorkerId;
        await using (var firstScope = factory.Services.CreateAsyncScope())
        {
            var worker = firstScope.ServiceProvider.GetRequiredService<ResponsesWorker>();
            firstWorkerId = worker.WorkerId;
            Assert.True(await worker.ProcessOneAsync());
        }

        await using (var secondScope = factory.Services.CreateAsyncScope())
        {
            var worker = secondScope.ServiceProvider.GetRequiredService<ResponsesWorker>();
            Assert.Equal(firstWorkerId, worker.WorkerId);
            Assert.True(await worker.ProcessOneAsync());
        }

        Assert.Equal(1, runtime.CreateCalls);
        Assert.Equal(1, runtime.RetrieveCalls);
        var task = await client.GetFromJsonAsync<JsonElement>($"/api/v1/tasks/{taskId}");
        Assert.Equal("succeeded", task.GetProperty("status").GetString());
        Assert.Equal("resp_existing_1", task.GetProperty("execution").GetProperty("externalExecutionId").GetString());
    }

    [Fact]
    public async Task PollingAnExistingResponseRenewsTheRunningLease()
    {
        var clock = new AdvancingTimeProvider(new DateTimeOffset(2030, 1, 1, 0, 0, 0, TimeSpan.Zero));
        var runtime = new QueueResponsesRuntime();
        using var factory = new TestApplicationFactory(
            null,
            true,
            null,
            clock,
            null,
            null,
            null,
            null,
            runtime);
        using var client = factory.CreateClient();
        client.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", factory.Token);
        var conversationId = await CreateConversationAsync(client);
        var taskId = await CreateResponsesTaskAsync(client, conversationId);

        await using (var firstScope = factory.Services.CreateAsyncScope())
        {
            Assert.True(await firstScope.ServiceProvider.GetRequiredService<ResponsesWorker>().ProcessOneAsync());
        }

        clock.Advance(TimeSpan.FromSeconds(60));
        await using (var secondScope = factory.Services.CreateAsyncScope())
        {
            Assert.True(await secondScope.ServiceProvider.GetRequiredService<ResponsesWorker>().ProcessOneAsync());
        }

        await using var verificationScope = factory.Services.CreateAsyncScope();
        var db = verificationScope.ServiceProvider.GetRequiredService<JarvisDbContext>();
        var task = await db.Tasks.SingleAsync(item => item.Id == taskId);
        Assert.Equal(Jarvis.Domain.Tasks.TaskStatus.Running, task.Status);
        Assert.True(task.LeaseExpiresAtMs > clock.GetUtcNow().ToUnixTimeMilliseconds() + 60_000);
    }

    private static async Task<Guid> CreateResponsesTaskAsync(HttpClient client, Guid conversationId)
    {
        using var create = new HttpRequestMessage(HttpMethod.Post, "/api/v1/tasks")
        {
            Content = JsonContent.Create(new
            {
                conversationId,
                sourceMessageIds = Array.Empty<Guid>(),
                goal = "总结这段文本",
                expectedOutput = "简洁总结",
                requiredCapabilities = DeepReasoningCapabilities
            })
        };
        create.Headers.Add("Idempotency-Key", $"responses-task-{Guid.CreateVersion7():N}");
        using var created = await client.SendAsync(create);
        created.EnsureSuccessStatusCode();
        return (await created.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("taskId").GetGuid();
    }

    private static async Task<Guid> CreateConversationAsync(HttpClient client)
    {
        using var request = new HttpRequestMessage(HttpMethod.Post, "/api/v1/conversations")
        {
            Content = JsonContent.Create(new { title = "responses" })
        };
        request.Headers.Add("Idempotency-Key", $"responses-conversation-{Guid.CreateVersion7():N}");
        using var response = await client.SendAsync(request);
        response.EnsureSuccessStatusCode();
        return (await response.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("id").GetGuid();
    }

    private sealed class ScriptedResponsesRuntime : IResponsesRuntime
    {
        public int CreateCalls { get; private set; }

        public Task<ResponsesResult> CreateAsync(ResponsesCreateRequest request, CancellationToken cancellationToken)
        {
            CreateCalls++;
            return Task.FromResult(new ResponsesResult("resp_test_1", ResponsesStatus.Completed, "测试总结"));
        }

        public Task<ResponsesResult> RetrieveAsync(string responseId, CancellationToken cancellationToken) =>
            Task.FromResult(new ResponsesResult(responseId, ResponsesStatus.Completed, "测试总结"));

        public Task<ResponsesResult> CancelAsync(string responseId, CancellationToken cancellationToken) =>
            Task.FromResult(new ResponsesResult(responseId, ResponsesStatus.Cancelled));
    }

    private sealed class QueueThenCompleteResponsesRuntime : IResponsesRuntime
    {
        public int CreateCalls { get; private set; }

        public int RetrieveCalls { get; private set; }

        public Task<ResponsesResult> CreateAsync(ResponsesCreateRequest request, CancellationToken cancellationToken)
        {
            CreateCalls++;
            return Task.FromResult(new ResponsesResult("resp_existing_1", ResponsesStatus.Queued));
        }

        public Task<ResponsesResult> RetrieveAsync(string responseId, CancellationToken cancellationToken)
        {
            RetrieveCalls++;
            return Task.FromResult(new ResponsesResult(responseId, ResponsesStatus.Completed, "跨 scope 恢复"));
        }

        public Task<ResponsesResult> CancelAsync(string responseId, CancellationToken cancellationToken) =>
            Task.FromResult(new ResponsesResult(responseId, ResponsesStatus.Cancelled));
    }

    private sealed class QueueResponsesRuntime : IResponsesRuntime
    {
        public int CreateCalls { get; private set; }

        public Task<ResponsesResult> CreateAsync(ResponsesCreateRequest request, CancellationToken cancellationToken)
        {
            CreateCalls++;
            return Task.FromResult(new ResponsesResult("resp_queued_1", ResponsesStatus.Queued));
        }

        public Task<ResponsesResult> RetrieveAsync(string responseId, CancellationToken cancellationToken) =>
            Task.FromResult(new ResponsesResult(responseId, ResponsesStatus.InProgress));

        public Task<ResponsesResult> CancelAsync(string responseId, CancellationToken cancellationToken) =>
            Task.FromResult(new ResponsesResult(responseId, ResponsesStatus.Cancelled));
    }

    private sealed class TerminalFailureResponsesRuntime(
        ResponsesStatus status,
        string errorCode,
        string errorMessage) : IResponsesRuntime
    {
        public Task<ResponsesResult> CreateAsync(ResponsesCreateRequest request, CancellationToken cancellationToken) =>
            Task.FromResult(new ResponsesResult("resp_terminal", status, ErrorCode: errorCode, ErrorMessage: errorMessage));

        public Task<ResponsesResult> RetrieveAsync(string responseId, CancellationToken cancellationToken) =>
            Task.FromResult(new ResponsesResult(responseId, status, ErrorCode: errorCode, ErrorMessage: errorMessage));

        public Task<ResponsesResult> CancelAsync(string responseId, CancellationToken cancellationToken) =>
            Task.FromResult(new ResponsesResult(responseId, ResponsesStatus.Cancelled));
    }

    private sealed class QueueThenCancelResponsesRuntime : IResponsesRuntime
    {
        public int CreateCalls { get; private set; }

        public int CancelCalls { get; private set; }

        public Task<ResponsesResult> CreateAsync(ResponsesCreateRequest request, CancellationToken cancellationToken)
        {
            CreateCalls++;
            return Task.FromResult(new ResponsesResult("resp_cancel_1", ResponsesStatus.Queued));
        }

        public Task<ResponsesResult> RetrieveAsync(string responseId, CancellationToken cancellationToken) =>
            Task.FromResult(new ResponsesResult(responseId, ResponsesStatus.InProgress));

        public Task<ResponsesResult> CancelAsync(string responseId, CancellationToken cancellationToken)
        {
            CancelCalls++;
            return Task.FromResult(new ResponsesResult(responseId, ResponsesStatus.Cancelled));
        }
    }

    private sealed class ExpiredLeaseResponsesRuntime : IResponsesRuntime
    {
        public int CreateCalls { get; private set; }

        public int RetrieveCalls { get; private set; }

        public Task<ResponsesResult> CreateAsync(ResponsesCreateRequest request, CancellationToken cancellationToken)
        {
            CreateCalls++;
            return Task.FromResult(new ResponsesResult("resp_expired", ResponsesStatus.Queued));
        }

        public Task<ResponsesResult> RetrieveAsync(string responseId, CancellationToken cancellationToken)
        {
            RetrieveCalls++;
            return Task.FromResult(new ResponsesResult(responseId, ResponsesStatus.Completed, "recovered"));
        }

        public Task<ResponsesResult> CancelAsync(string responseId, CancellationToken cancellationToken) =>
            Task.FromResult(new ResponsesResult(responseId, ResponsesStatus.Cancelled));
    }

    private sealed class AdvancingTimeProvider(DateTimeOffset initial) : TimeProvider
    {
        private DateTimeOffset now = initial;

        public override DateTimeOffset GetUtcNow() => now;

        public void Advance(TimeSpan duration) => now += duration;
    }
}
