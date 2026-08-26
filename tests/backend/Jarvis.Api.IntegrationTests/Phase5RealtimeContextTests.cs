using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Text.Json;
using Jarvis.Application.Identity;
using Jarvis.Application.Realtime;
using Jarvis.Contracts;
using Jarvis.Domain.Conversations;
using Jarvis.Domain.Identity;
using Jarvis.Domain.Memory;
using Jarvis.Domain.Notifications;
using Jarvis.Domain.Tasks;
using Jarvis.Infrastructure.Data;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Task = System.Threading.Tasks.Task;
using Xunit;

namespace Jarvis.Api.IntegrationTests;

public sealed class Phase5RealtimeContextTests
{
    [Fact]
    public async Task BootstrapLoadsSummaryDeltaTasksUnreadResultsAndNonSensitiveMemoryWithBoundedSections()
    {
        using var factory = new TestApplicationFactory(
            null,
            true,
            null,
            null,
            null,
            new FakeRealtimeClientSecretProvider());
        using var client = factory.CreateClient();
        client.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", factory.Token);
        var conversationId = await CreateConversationAsync(client);
        await AddMessageAsync(client, conversationId, "旧消息一", "context-old-1");
        await AddMessageAsync(client, conversationId, "旧消息二", "context-old-2");
        await AddMessageAsync(client, conversationId, "摘要之后的新消息", "context-new-1");

        Guid deviceId;
        await using (var seedScope = factory.Services.CreateAsyncScope())
        {
            var db = seedScope.ServiceProvider.GetRequiredService<JarvisDbContext>();
            var userId = (await db.Users.Select(item => (Guid?)item.Id).SingleAsync())!.Value;
            var nowMs = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
            var summary = ConversationSummary.Create(
                Guid.CreateVersion7(),
                conversationId,
                1,
                2,
                "持久摘要：旧消息已被压缩。",
                "test-summary-model",
                nowMs);
            db.ConversationSummaries.Add(summary);
            var conversation = await db.Conversations.SingleAsync(item => item.Id == conversationId);
            conversation.SetCurrentSummary(summary.Id);

            var running = CreateTask(userId, conversationId, "需要继续处理的任务", nowMs);
            db.Tasks.Add(running);
            var completed = CreateTask(userId, conversationId, "已完成结果任务", nowMs);
            completed.Assign("context-test", nowMs + 60_000, nowMs);
            completed.Start(nowMs);
            completed.MarkSucceeded("持久化任务结果", nowMs);
            db.Tasks.Add(completed);
            db.Notifications.Add(Notification.Create(
                Guid.CreateVersion7(),
                userId,
                conversationId,
                completed.Id,
                "task.completed",
                NotificationSeverity.Success,
                "任务完成",
                "持久化任务结果",
                $"context-test:{completed.Id:D}",
                nowMs));
            db.MemoryFacts.Add(MemoryFact.CreateDirect(
                Guid.CreateVersion7(),
                userId,
                "communication.responseLength",
                JsonSerializer.Serialize("prefer concise"),
                null,
                sensitive: false,
                nowMs));
            db.MemoryFacts.Add(MemoryFact.CreateDirect(
                Guid.CreateVersion7(),
                userId,
                "secret.internal",
                JsonSerializer.Serialize("do not include"),
                null,
                sensitive: true,
                nowMs));
            deviceId = await db.Devices
                .Where(item => item.UserId == userId && item.DeviceType == Domain.Devices.DeviceType.Desktop)
                .Select(item => item.Id)
                .FirstAsync();
            await db.SaveChangesAsync();
        }

        using var secretRequest = new HttpRequestMessage(HttpMethod.Post, "/api/v1/realtime/client-secrets")
        {
            Content = JsonContent.Create(new RealtimeClientSecretRequest(conversationId, deviceId))
        };
        secretRequest.Headers.Add("Idempotency-Key", "context-bootstrap");
        using var secretResponse = await client.SendAsync(secretRequest);
        secretResponse.EnsureSuccessStatusCode();
        var secret = await secretResponse.Content.ReadFromJsonAsync<RealtimeClientSecretResponse>();
        Assert.NotNull(secret);
        Assert.Contains("持久摘要：旧消息已被压缩。", secret!.Instructions, StringComparison.Ordinal);
        Assert.Contains("摘要之后的新消息", secret.Instructions, StringComparison.Ordinal);
        Assert.Contains("需要继续处理的任务", secret.Instructions, StringComparison.Ordinal);
        Assert.Contains("持久化任务结果", secret.Instructions, StringComparison.Ordinal);
        Assert.Contains("prefer concise", secret.Instructions, StringComparison.Ordinal);
        Assert.DoesNotContain("旧消息一", secret.Instructions, StringComparison.Ordinal);
        Assert.DoesNotContain("do not include", secret.Instructions, StringComparison.Ordinal);
        Assert.True(secret.ContextVersion > 0);
        Assert.True(ContextAssembler.EstimateTokens(secret.Instructions) > 0);
    }

    [Fact]
    public async Task ContextVersionAdvancesWhenNewFactsTasksAndUnreadResultsStartAtVersionZero()
    {
        using var factory = new TestApplicationFactory(
            null,
            true,
            null,
            null,
            null,
            new FakeRealtimeClientSecretProvider());
        using var client = factory.CreateClient();
        client.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", factory.Token);
        var conversationId = await CreateConversationAsync(client);
        using var deviceResponse = await PostAsync(client, "/api/v1/realtime/desktop-device", new { }, "context-version-device");
        deviceResponse.EnsureSuccessStatusCode();
        var device = await deviceResponse.Content.ReadFromJsonAsync<DesktopDeviceBootstrapResponse>();
        Assert.NotNull(device);

        Guid baselineTaskId;
        await using (var seedScope = factory.Services.CreateAsyncScope())
        {
            var db = seedScope.ServiceProvider.GetRequiredService<JarvisDbContext>();
            var userId = (await db.Users.Select(item => (Guid?)item.Id).SingleAsync())!.Value;
            var nowMs = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
            var completed = CreateTask(userId, conversationId, "既有终态结果", nowMs);
            completed.Assign("context-version", nowMs + 60_000, nowMs);
            completed.Start(nowMs);
            completed.MarkSucceeded("既有结果", nowMs);
            db.Tasks.Add(completed);
            db.Notifications.Add(Notification.Create(
                Guid.CreateVersion7(),
                userId,
                conversationId,
                completed.Id,
                "task.completed",
                NotificationSeverity.Success,
                "既有结果",
                "既有结果",
                $"context-version:{completed.Id:D}",
                nowMs));
            baselineTaskId = completed.Id;
            await db.SaveChangesAsync();
        }

        var before = await CreateSecretAsync(client, conversationId, device!.DeviceId, "context-version-before");
        await using (var seedScope = factory.Services.CreateAsyncScope())
        {
            var db = seedScope.ServiceProvider.GetRequiredService<JarvisDbContext>();
            var userId = (await db.Users.Select(item => (Guid?)item.Id).SingleAsync())!.Value;
            var nowMs = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
            var queued = CreateTask(userId, conversationId, "新增未完成任务", nowMs);
            db.Tasks.Add(queued);
            db.Notifications.Add(Notification.Create(
                Guid.CreateVersion7(),
                userId,
                conversationId,
                baselineTaskId,
                "task.completed",
                NotificationSeverity.Success,
                "新增未读结果",
                "新增未读结果",
                "context-version:new-result",
                nowMs));
            db.MemoryFacts.Add(MemoryFact.CreateDirect(
                Guid.CreateVersion7(),
                userId,
                "new.fact",
                JsonSerializer.Serialize("new"),
                null,
                sensitive: false,
                nowMs));
            await db.SaveChangesAsync();
        }

        var after = await CreateSecretAsync(client, conversationId, device.DeviceId, "context-version-after");
        Assert.True(after.ContextVersion > before.ContextVersion);
    }

    [Fact]
    public async Task BootstrapDoesNotIncludeTasksOrUnreadResultsOwnedByAnotherUser()
    {
        using var factory = new TestApplicationFactory(
            null,
            true,
            null,
            null,
            null,
            new FakeRealtimeClientSecretProvider());
        using var client = factory.CreateClient();
        client.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", factory.Token);
        var conversationId = await CreateConversationAsync(client);
        using var deviceResponse = await PostAsync(client, "/api/v1/realtime/desktop-device", new { }, "context-pollution-device");
        deviceResponse.EnsureSuccessStatusCode();
        var device = await deviceResponse.Content.ReadFromJsonAsync<DesktopDeviceBootstrapResponse>();
        Assert.NotNull(device);

        var before = await CreateSecretAsync(client, conversationId, device!.DeviceId, "context-pollution-before");
        await using (var seedScope = factory.Services.CreateAsyncScope())
        {
            var db = seedScope.ServiceProvider.GetRequiredService<JarvisDbContext>();
            var currentUserId = (await db.Users.Select(item => (Guid?)item.Id).SingleAsync())!.Value;
            var otherUserId = Guid.CreateVersion7();
            var nowMs = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
            db.Users.Add(User.Create(otherUserId, "Other user", "en-US", "UTC", nowMs));
            var foreignTask = CreateTask(otherUserId, conversationId, "foreign task must not appear", nowMs);
            db.Tasks.Add(foreignTask);
            db.Notifications.Add(Notification.Create(
                Guid.CreateVersion7(),
                otherUserId,
                conversationId,
                foreignTask.Id,
                "task.completed",
                NotificationSeverity.Success,
                "foreign result title",
                "foreign result body",
                $"foreign-context:{foreignTask.Id:D}",
                nowMs));
            await db.SaveChangesAsync();
            Assert.NotEqual(currentUserId, otherUserId);
        }

        var after = await CreateSecretAsync(client, conversationId, device.DeviceId, "context-pollution-after");
        Assert.Equal(before.ContextVersion, after.ContextVersion);
        Assert.DoesNotContain("foreign task must not appear", after.Instructions, StringComparison.Ordinal);
        Assert.DoesNotContain("foreign result body", after.Instructions, StringComparison.Ordinal);
    }

    private static Domain.Tasks.Task CreateTask(Guid userId, Guid conversationId, string goal, long nowMs) =>
        Domain.Tasks.Task.Create(
            Guid.CreateVersion7(),
            userId,
            conversationId,
            goal,
            null,
            "[]",
            "[]",
            null,
            WorkerKind.Internal,
            0,
            nowMs);

    private static async Task<Guid> CreateConversationAsync(HttpClient client)
    {
        using var request = new HttpRequestMessage(HttpMethod.Post, "/api/v1/conversations")
        {
            Content = JsonContent.Create(new { title = "context" })
        };
        request.Headers.Add("Idempotency-Key", "context-conversation");
        using var response = await client.SendAsync(request);
        response.EnsureSuccessStatusCode();
        return (await response.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("id").GetGuid();
    }

    private static async Task AddMessageAsync(HttpClient client, Guid conversationId, string text, string clientRequestId)
    {
        using var request = new HttpRequestMessage(HttpMethod.Post, $"/api/v1/conversations/{conversationId}/messages/typed")
        {
            Content = JsonContent.Create(new { clientRequestId, text })
        };
        request.Headers.Add("Idempotency-Key", $"context-{clientRequestId}");
        using var response = await client.SendAsync(request);
        response.EnsureSuccessStatusCode();
    }

    private static async Task<RealtimeClientSecretResponse> CreateSecretAsync(
        HttpClient client,
        Guid conversationId,
        Guid deviceId,
        string idempotencyKey)
    {
        using var request = new HttpRequestMessage(HttpMethod.Post, "/api/v1/realtime/client-secrets")
        {
            Content = JsonContent.Create(new RealtimeClientSecretRequest(conversationId, deviceId))
        };
        request.Headers.Add("Idempotency-Key", idempotencyKey);
        using var response = await client.SendAsync(request);
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
        public Task<RealtimeClientSecretProviderResponse> CreateAsync(
            RealtimeClientSecretProviderRequest request,
            CancellationToken cancellationToken) =>
            Task.FromResult(new RealtimeClientSecretProviderResponse(
                "ek_context",
                DateTimeOffset.UtcNow.AddMinutes(5).ToUnixTimeMilliseconds(),
                "oai-context",
                "gpt-4o-realtime-preview",
                "alloy"));
    }
}
