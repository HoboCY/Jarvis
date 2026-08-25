using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Text.Json;
using Jarvis.Contracts;
using Jarvis.Infrastructure.Data;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Xunit;

namespace Jarvis.Api.IntegrationTests;

public sealed class TaskApiTests : IClassFixture<TestApplicationFactory>
{
    private static readonly string[] RequiredCapabilities = ["localFiles", "deepReasoning"];
    private static readonly string[] UnknownCapabilities = ["unknownCapability"];
    private static readonly string[] AttachmentRefs = ["file:///reports/source.csv", "artifact://result/1"];
    private readonly TestApplicationFactory factory;

    public TaskApiTests(TestApplicationFactory factory)
    {
        this.factory = factory;
    }

    [Fact]
    public async Task CreateTaskReturnsQuicklyAndPersistsTaskEventIdempotencyAndOutbox()
    {
        using var client = factory.CreateClient();
        client.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", factory.Token);
        var conversation = await CreateConversationAsync(client);

        using var request = new HttpRequestMessage(HttpMethod.Post, "/api/v1/tasks")
        {
            Content = JsonContent.Create(new
            {
                conversationId = conversation,
                sourceMessageIds = Array.Empty<Guid>(),
                goal = "分析下载目录中的报表",
                expectedOutput = "中文结论",
                requiredCapabilities = RequiredCapabilities,
                preferredDeviceId = (Guid?)null,
                attachmentRefs = AttachmentRefs
            })
        };
        request.Headers.Add("Idempotency-Key", "task-create-one");

        using var response = await client.SendAsync(request);

        Assert.Equal(HttpStatusCode.Accepted, response.StatusCode);
        using var document = JsonDocument.Parse(await response.Content.ReadAsStringAsync());
        var root = document.RootElement;
        Assert.True(root.GetProperty("accepted").GetBoolean());
        var taskId = root.GetProperty("taskId").GetGuid();
        Assert.Equal("queued", root.GetProperty("status").GetString());
        Assert.Equal("codex", root.GetProperty("workerKind").GetString());

        var persisted = await client.GetFromJsonAsync<JsonElement>($"/api/v1/tasks/{taskId}");
        Assert.Equal(
            AttachmentRefs,
            persisted.GetProperty("attachmentRefs").EnumerateArray().Select(item => item.GetString()).ToArray());

        using var scope = factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<JarvisDbContext>();
        Assert.Equal(1, await db.Tasks.CountAsync(task => task.Id == taskId));
        Assert.Equal(1, await db.TaskEvents.CountAsync(taskEvent => taskEvent.TaskId == taskId));
        Assert.Equal(1, await db.IdempotencyRecords.CountAsync(record => record.Scope == "tasks:create" && record.IdempotencyKey == "task-create-one"));
        Assert.Contains(
            await db.OutboxMessages.Where(message => message.EventType == "task.updated").Select(message => message.PayloadJson).ToListAsync(),
            payload => payload.Contains(taskId.ToString(), StringComparison.OrdinalIgnoreCase));
    }

    [Fact]
    public async Task ConcurrentSameKeyCreatesOneTaskAndReplaysTheAcceptedResponse()
    {
        using var client = factory.CreateClient();
        client.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", factory.Token);
        var conversationId = await CreateConversationAsync(client);

        async Task<HttpResponseMessage> SendAsync()
        {
            using var request = new HttpRequestMessage(HttpMethod.Post, "/api/v1/tasks")
            {
                Content = JsonContent.Create(new
                {
                    conversationId,
                    sourceMessageIds = Array.Empty<Guid>(),
                    goal = "并发幂等任务",
                    expectedOutput = "一次",
                    requiredCapabilities = RequiredCapabilities,
                    preferredDeviceId = (Guid?)null
                })
            };
            request.Headers.Add("Idempotency-Key", "task-concurrent-one");
            return await client.SendAsync(request);
        }

        var responses = await Task.WhenAll(SendAsync(), SendAsync());
        try
        {
            foreach (var response in responses)
            {
                response.EnsureSuccessStatusCode();
            }

            using var firstJson = JsonDocument.Parse(await responses[0].Content.ReadAsStringAsync());
            using var secondJson = JsonDocument.Parse(await responses[1].Content.ReadAsStringAsync());
            var firstTaskId = firstJson.RootElement.GetProperty("taskId").GetGuid();
            var secondTaskId = secondJson.RootElement.GetProperty("taskId").GetGuid();
            Assert.Equal(firstTaskId, secondTaskId);

            using var scope = factory.Services.CreateScope();
            var db = scope.ServiceProvider.GetRequiredService<JarvisDbContext>();
            Assert.Equal(1, await db.Tasks.CountAsync(task => task.Id == firstTaskId));
            Assert.Equal(1, await db.IdempotencyRecords.CountAsync(record => record.Scope == "tasks:create" && record.IdempotencyKey == "task-concurrent-one"));
        }
        finally
        {
            foreach (var response in responses)
            {
                response.Dispose();
            }
        }
    }

    [Fact]
    public async Task SameKeyWithDifferentPayloadReturnsConflict()
    {
        using var client = factory.CreateClient();
        client.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", factory.Token);
        var conversationId = await CreateConversationAsync(client);

        async Task<HttpResponseMessage> SendAsync(string goal)
        {
            using var request = new HttpRequestMessage(HttpMethod.Post, "/api/v1/tasks")
            {
                Content = JsonContent.Create(new
                {
                    conversationId,
                    sourceMessageIds = Array.Empty<Guid>(),
                    goal,
                    expectedOutput = "一次",
                    requiredCapabilities = RequiredCapabilities,
                    preferredDeviceId = (Guid?)null
                })
            };
            request.Headers.Add("Idempotency-Key", "task-conflict-one");
            return await client.SendAsync(request);
        }

        using var created = await SendAsync("第一次");
        using var conflict = await SendAsync("第二次");
        Assert.Equal(HttpStatusCode.Accepted, created.StatusCode);
        Assert.Equal(HttpStatusCode.Conflict, conflict.StatusCode);
    }

    [Fact]
    public async Task SameKeyWithDifferentAttachmentRefsReturnsConflict()
    {
        using var client = factory.CreateClient();
        client.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", factory.Token);
        var conversationId = await CreateConversationAsync(client);

        async Task<HttpResponseMessage> SendAsync(string attachmentRef)
        {
            using var request = new HttpRequestMessage(HttpMethod.Post, "/api/v1/tasks")
            {
                Content = JsonContent.Create(new
                {
                    conversationId,
                    sourceMessageIds = Array.Empty<Guid>(),
                    goal = "same goal",
                    expectedOutput = "same output",
                    requiredCapabilities = RequiredCapabilities,
                    attachmentRefs = new[] { attachmentRef }
                })
            };
            request.Headers.Add("Idempotency-Key", "task-attachment-conflict");
            return await client.SendAsync(request);
        }

        using var created = await SendAsync("artifact://one");
        using var conflict = await SendAsync("artifact://two");
        Assert.Equal(HttpStatusCode.Accepted, created.StatusCode);
        Assert.Equal(HttpStatusCode.Conflict, conflict.StatusCode);
    }

    [Fact]
    public async Task UnknownCapabilityReturnsProblemDetailsBadRequest()
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
                goal = "拒绝未知能力",
                expectedOutput = "400",
                requiredCapabilities = UnknownCapabilities,
                preferredDeviceId = (Guid?)null
            })
        };
        request.Headers.Add("Idempotency-Key", "task-unknown-capability");

        using var response = await client.SendAsync(request);

        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
        Assert.Equal("application/problem+json", response.Content.Headers.ContentType?.MediaType);
    }

    [Fact]
    public async Task TaskListUsesOpaqueCompositeCursorForSameTimestampAndHonorsFilters()
    {
        var now = new DateTimeOffset(2030, 1, 2, 3, 4, 5, TimeSpan.Zero);
        using var isolatedFactory = new TestApplicationFactory(
            databasePath: null,
            deleteDatabaseOnDispose: true,
            outboxPublisher: null,
            timeProvider: new FixedTimeProvider(now));
        using var client = isolatedFactory.CreateClient();
        client.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", isolatedFactory.Token);
        var conversationId = await CreateConversationAsync(client);
        var expectedTaskIds = new List<Guid>();
        for (var index = 0; index < 5; index++)
        {
            expectedTaskIds.Add(await CreateTaskAsync(client, conversationId, $"same timestamp {index}"));
        }

        var pageTaskIds = new List<Guid>();
        string? cursor = null;
        for (var page = 0; page < 3; page++)
        {
            var query = $"/api/v1/tasks?conversationId={conversationId}&status=queued&limit=2"
                + (cursor is null ? string.Empty : $"&cursor={Uri.EscapeDataString(cursor)}");
            var response = await client.GetFromJsonAsync<JsonElement>(query);
            foreach (var item in response.GetProperty("items").EnumerateArray())
            {
                Assert.Equal("queued", item.GetProperty("status").GetString());
                Assert.True(item.GetProperty("entityVersion").GetInt64() >= 0);
                pageTaskIds.Add(item.GetProperty("id").GetGuid());
            }

            cursor = response.GetProperty("nextCursor").ValueKind is JsonValueKind.Null
                ? null
                : response.GetProperty("nextCursor").GetString();
            if (page < 2)
            {
                Assert.NotNull(cursor);
                Assert.DoesNotMatch("^[0-9]+$", cursor!);
            }
        }

        Assert.Null(cursor);
        Assert.Equal(expectedTaskIds.Count, pageTaskIds.Count);
        Assert.Equal(expectedTaskIds.Count, pageTaskIds.Distinct().Count());
        Assert.All(expectedTaskIds, taskId => Assert.Contains(taskId, pageTaskIds));

        using var malformed = await client.GetAsync("/api/v1/tasks?cursor=not-a-valid-cursor");
        Assert.Equal(HttpStatusCode.BadRequest, malformed.StatusCode);
        Assert.Equal("application/problem+json", malformed.Content.Headers.ContentType?.MediaType);
    }

    [Theory]
    [InlineData(TaskStatusValue.Assigned)]
    [InlineData(TaskStatusValue.WaitingForApproval)]
    [InlineData(TaskStatusValue.WaitingForUserInput)]
    [InlineData(TaskStatusValue.Recovering)]
    public async Task CancelForNonCancellableStateReturnsConflictAndReplaysWithTheSameKey(TaskStatusValue status)
    {
        using var client = factory.CreateClient();
        client.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", factory.Token);
        var taskId = await CreateTaskAsync(client);
        await SetTaskStateAsync(taskId, status);

        using var first = await SendCancelAsync(client, taskId, "cancel-state-conflict");
        using var replay = await SendCancelAsync(client, taskId, "cancel-state-conflict");

        Assert.Equal(HttpStatusCode.Conflict, first.StatusCode);
        Assert.Equal("application/problem+json", first.Content.Headers.ContentType?.MediaType);
        Assert.Equal(HttpStatusCode.Conflict, replay.StatusCode);
        Assert.Equal("application/problem+json", replay.Content.Headers.ContentType?.MediaType);

        var firstProblem = await first.Content.ReadFromJsonAsync<JsonElement>();
        var replayProblem = await replay.Content.ReadFromJsonAsync<JsonElement>();
        Assert.Equal(409, firstProblem.GetProperty("status").GetInt32());
        Assert.Equal("Task state conflict", firstProblem.GetProperty("title").GetString());
        Assert.Equal(firstProblem.GetProperty("detail").GetString(), replayProblem.GetProperty("detail").GetString());
        Assert.Equal(firstProblem.GetProperty("title").GetString(), replayProblem.GetProperty("title").GetString());
    }

    private static async Task<Guid> CreateTaskAsync(HttpClient client)
    {
        var conversationId = await CreateConversationAsync(client);
        using var request = new HttpRequestMessage(HttpMethod.Post, "/api/v1/tasks")
        {
            Content = JsonContent.Create(new
            {
                conversationId,
                sourceMessageIds = Array.Empty<Guid>(),
                goal = "不可取消状态",
                expectedOutput = "冲突",
                requiredCapabilities = RequiredCapabilities,
                preferredDeviceId = (Guid?)null
            })
        };
        request.Headers.Add("Idempotency-Key", $"cancel-state-task-{Guid.CreateVersion7():N}");
        using var response = await client.SendAsync(request);
        response.EnsureSuccessStatusCode();
        using var document = JsonDocument.Parse(await response.Content.ReadAsStringAsync());
        return document.RootElement.GetProperty("taskId").GetGuid();
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
                expectedOutput = "分页",
                requiredCapabilities = RequiredCapabilities,
                preferredDeviceId = (Guid?)null
            })
        };
        request.Headers.Add("Idempotency-Key", $"pagination-task-{Guid.CreateVersion7():N}");
        using var response = await client.SendAsync(request);
        response.EnsureSuccessStatusCode();
        using var document = JsonDocument.Parse(await response.Content.ReadAsStringAsync());
        return document.RootElement.GetProperty("taskId").GetGuid();
    }

    private async Task SetTaskStateAsync(Guid taskId, TaskStatusValue status)
    {
        await using var scope = factory.Services.CreateAsyncScope();
        var db = scope.ServiceProvider.GetRequiredService<JarvisDbContext>();
        var task = await db.Tasks.SingleAsync(item => item.Id == taskId);
        var nowMs = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        switch (status)
        {
            case TaskStatusValue.Assigned:
                task.Assign("api-state-test-worker", nowMs + 60_000, nowMs);
                break;
            case TaskStatusValue.WaitingForApproval:
                task.Assign("api-state-test-worker", nowMs + 60_000, nowMs);
                task.Start(nowMs);
                task.WaitForApproval(nowMs);
                break;
            case TaskStatusValue.WaitingForUserInput:
                task.Assign("api-state-test-worker", nowMs + 60_000, nowMs);
                task.Start(nowMs);
                task.WaitForUserInput(nowMs);
                break;
            case TaskStatusValue.Recovering:
                task.Assign("api-state-test-worker", nowMs + 60_000, nowMs);
                task.Start(nowMs);
                task.MarkRecovering(nowMs);
                break;
            default:
                throw new ArgumentOutOfRangeException(nameof(status), status, null);
        }

        await db.SaveChangesAsync();
    }

    private static async Task<HttpResponseMessage> SendCancelAsync(
        HttpClient client,
        Guid taskId,
        string idempotencyKey)
    {
        using var request = new HttpRequestMessage(HttpMethod.Post, $"/api/v1/tasks/{taskId}/cancel");
        request.Headers.Add("Idempotency-Key", idempotencyKey);
        return await client.SendAsync(request);
    }

    private static async Task<Guid> CreateConversationAsync(HttpClient client)
    {
        using var request = new HttpRequestMessage(HttpMethod.Post, "/api/v1/conversations")
        {
            Content = JsonContent.Create(new { title = "Task test" })
        };
        request.Headers.Add("Idempotency-Key", $"conversation-{Guid.CreateVersion7():N}");
        using var response = await client.SendAsync(request);
        response.EnsureSuccessStatusCode();
        using var document = JsonDocument.Parse(await response.Content.ReadAsStringAsync());
        return document.RootElement.GetProperty("id").GetGuid();
    }

    private sealed class FixedTimeProvider(DateTimeOffset now) : TimeProvider
    {
        public override DateTimeOffset GetUtcNow() => now;
    }
}
