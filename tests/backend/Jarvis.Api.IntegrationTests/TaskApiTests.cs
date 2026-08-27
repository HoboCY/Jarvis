using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Text.Json;
using Jarvis.Contracts;
using DomainNotificationStatus = Jarvis.Domain.Notifications.NotificationStatus;
using DomainTaskStatus = Jarvis.Domain.Tasks.TaskStatus;
using DomainTaskExecutionStatus = Jarvis.Domain.Tasks.TaskExecutionStatus;
using DomainTaskUserInputStatus = Jarvis.Domain.Tasks.TaskUserInputRequestStatus;
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
    private static readonly CapabilityEnvelopeContract TaskCapabilityEnvelope = new(
        ReadFiles: true,
        AllowedRoots: [Path.GetTempPath()]);
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
                attachmentRefs = AttachmentRefs,
                capabilityEnvelope = TaskCapabilityEnvelope
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
    public async Task DeviceUserInputRequestWaitsAndUiSubmissionResumesTheSameExecution()
    {
        using var ui = factory.CreateClient();
        ui.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", factory.Token);
        var conversationId = await CreateConversationAsync(ui);
        var taskId = await CreateTaskAsync(ui, conversationId, "answer the bounded question");

        using var registrationRequest = new HttpRequestMessage(HttpMethod.Post, "/api/v1/devices/register")
        {
            Content = JsonContent.Create(new DeviceRegistrationRequest(
                "User input node",
                DeviceTypeValue.Desktop,
                "macos",
                ["localFiles", "deepReasoning"],
                [Path.GetTempPath()]))
        };
        registrationRequest.Headers.Add("Idempotency-Key", $"user-input-register-{Guid.CreateVersion7():N}");
        using var registrationResponse = await ui.SendAsync(registrationRequest);
        registrationResponse.EnsureSuccessStatusCode();
        var device = (await registrationResponse.Content.ReadFromJsonAsync<DeviceRegistrationResponse>())!;

        using var deviceClient = factory.CreateClient();
        deviceClient.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", device.DeviceCredential);
        using var heartbeat = new HttpRequestMessage(HttpMethod.Post, $"/api/v1/devices/{device.DeviceId:D}/heartbeat")
        {
            Content = JsonContent.Create(new DeviceHeartbeatRequest(["localFiles", "deepReasoning"], [Path.GetTempPath()]))
        };
        heartbeat.Headers.Add("Idempotency-Key", $"user-input-heartbeat-{Guid.CreateVersion7():N}");
        (await deviceClient.SendAsync(heartbeat)).EnsureSuccessStatusCode();

        using var claim = new HttpRequestMessage(HttpMethod.Post, "/api/v1/device-tasks/claim")
        {
            Content = JsonContent.Create(new DeviceTaskClaimRequest(
                "user-input-owner",
                new CapabilityEnvelopeContract(ReadFiles: true, AllowedRoots: [Path.GetTempPath()])))
        };
        claim.Headers.Add("Idempotency-Key", $"user-input-claim-{Guid.CreateVersion7():N}");
        using var claimResponse = await deviceClient.SendAsync(claim);
        claimResponse.EnsureSuccessStatusCode();
        var claimed = (await claimResponse.Content.ReadFromJsonAsync<DeviceTaskClaimResponse>())!;
        Assert.True(claimed.Claimed);
        Assert.Equal(taskId, claimed.Task!.Id);

        deviceClient.DefaultRequestHeaders.Add("X-Lease-Owner", claimed.LeaseOwner);
        await AppendDeviceEventAsync(
            deviceClient,
            taskId,
            new DeviceTaskEventRequest(
                "user-input-turn-starting",
                claimed.Execution!.Id,
                "codex.turn.starting",
                CodexThreadId: "thread-user-input"),
            "user-input-turn-starting-key");
        await AppendDeviceEventAsync(
            deviceClient,
            taskId,
            new DeviceTaskEventRequest(
                "user-input-turn-started",
                claimed.Execution.Id,
                "codex.turn.started",
                CodexThreadId: "thread-user-input",
                CodexTurnId: "turn-user-input"),
            "user-input-turn-started-key");

        var inputRequest = new DeviceTaskUserInputRequest(
            claimed.Execution.Id,
            "99",
            "item-user-input",
            [new TaskUserInputQuestion(
                "Mode",
                "mode",
                "Which mode should Codex use?",
                Options: [
                    new TaskUserInputOption("Fast execution", "fast"),
                    new TaskUserInputOption("Careful execution", "careful")])],
            "thread-user-input",
            "turn-user-input");
        using var createInput = new HttpRequestMessage(HttpMethod.Post, $"/api/v1/device-tasks/{taskId:D}/user-input")
        {
            Content = JsonContent.Create(inputRequest)
        };
        createInput.Headers.Add("Idempotency-Key", "user-input-request-key");
        createInput.Headers.Add("X-Lease-Owner", claimed.LeaseOwner);
        using var inputResponse = await deviceClient.SendAsync(createInput);
        var inputResponseBody = await inputResponse.Content.ReadAsStringAsync();
        Assert.True(inputResponse.StatusCode == HttpStatusCode.Created, inputResponseBody);
        var deviceInput = await inputResponse.Content.ReadFromJsonAsync<DeviceTaskUserInputResponse>();
        Assert.Equal(TaskUserInputStatusValue.Pending, deviceInput!.Status);

        var waiting = await ui.GetFromJsonAsync<TaskResponse>($"/api/v1/tasks/{taskId:D}");
        Assert.Equal(TaskStatusValue.WaitingForUserInput, waiting!.Status);
        Assert.Equal("99", waiting.PendingUserInput!.RequestId);
        Assert.Equal("mode", waiting.PendingUserInput.Questions.Single().Id);

        using (var scope = factory.Services.CreateScope())
        {
            var db = scope.ServiceProvider.GetRequiredService<JarvisDbContext>();
            Assert.Equal(DomainTaskExecutionStatus.WaitingForUserInput, await db.TaskExecutions.Where(item => item.Id == claimed.Execution.Id).Select(item => item.Status).SingleAsync());
            Assert.Contains("task.userInputRequired", await db.TaskEvents.Where(item => item.TaskId == taskId).Select(item => item.EventType).ToListAsync());
            Assert.Contains("task.needsUserInput", await db.Notifications.Where(item => item.TaskId == taskId).Select(item => item.Type).ToListAsync());
            Assert.Contains("task.userInputRequired", await db.OutboxMessages.Select(item => item.EventType).ToListAsync());
        }

        using var submit = new HttpRequestMessage(HttpMethod.Post, $"/api/v1/tasks/{taskId:D}/user-input")
        {
            Content = JsonContent.Create(new TaskUserInputSubmissionRequest(
                "99",
                new Dictionary<string, TaskUserInputAnswer>
                {
                    ["mode"] = new TaskUserInputAnswer(["fast"])
                }))
        };
        submit.Headers.Add("Idempotency-Key", "user-input-answer-key");
        using var submitResponse = await ui.SendAsync(submit);
        Assert.Equal(HttpStatusCode.OK, submitResponse.StatusCode);
        var submitted = await submitResponse.Content.ReadFromJsonAsync<TaskUserInputSubmissionResponse>();
        Assert.True(submitted!.Accepted);
        Assert.Equal(claimed.Execution.Id, submitted.ExecutionId);
        Assert.Equal(TaskStatusValue.Running, submitted.Status);

        var resumed = await ui.GetFromJsonAsync<TaskResponse>($"/api/v1/tasks/{taskId:D}");
        Assert.Equal(TaskStatusValue.Running, resumed!.Status);
        Assert.Null(resumed.PendingUserInput);
        using (var scope = factory.Services.CreateScope())
        {
            var db = scope.ServiceProvider.GetRequiredService<JarvisDbContext>();
            Assert.Equal(DomainTaskExecutionStatus.Running, await db.TaskExecutions.Where(item => item.Id == claimed.Execution.Id).Select(item => item.Status).SingleAsync());
            Assert.Equal(DomainNotificationStatus.Actioned, await db.Notifications.Where(item => item.TaskId == taskId && item.Type == "task.needsUserInput").Select(item => item.Status).SingleAsync());
            var storedOutbox = await db.OutboxMessages.Where(item => item.EventType == "task.userInputAnswered").Select(item => item.PayloadJson).SingleAsync();
            Assert.DoesNotContain("fast", storedOutbox, StringComparison.Ordinal);
        }

        using var replay = new HttpRequestMessage(HttpMethod.Post, $"/api/v1/tasks/{taskId:D}/user-input")
        {
            Content = JsonContent.Create(new TaskUserInputSubmissionRequest(
                "99",
                new Dictionary<string, TaskUserInputAnswer>
                {
                    ["mode"] = new TaskUserInputAnswer(["fast"])
                }))
        };
        replay.Headers.Add("Idempotency-Key", "user-input-answer-key");
        using var replayResponse = await ui.SendAsync(replay);
        Assert.Equal(HttpStatusCode.OK, replayResponse.StatusCode);
    }

    [Fact]
    public async Task ExpiredUserInputMaintenanceFailsClosedWithoutDevicePolling()
    {
        var clock = new AdvancingTimeProvider(new DateTimeOffset(2030, 1, 2, 3, 4, 5, TimeSpan.Zero));
        await using var isolated = new TestApplicationFactory(
            databasePath: null,
            deleteDatabaseOnDispose: true,
            outboxPublisher: null,
            timeProvider: clock);
        await using (var setupScope = isolated.Services.CreateAsyncScope())
        {
            var db = setupScope.ServiceProvider.GetRequiredService<JarvisDbContext>();
            var nowMs = clock.GetUtcNow().ToUnixTimeMilliseconds();
            var userId = await db.Users.Select(item => item.Id).SingleAsync();
            var deviceId = await db.Devices.Select(item => item.Id).FirstAsync();
            var conversation = Jarvis.Domain.Conversations.Conversation.Create(
                Guid.CreateVersion7(),
                userId,
                "User input expiry",
                nowMs);
            var task = Jarvis.Domain.Tasks.Task.Create(
                Guid.CreateVersion7(),
                userId,
                conversation.Id,
                "wait for an expiring user input",
                null,
                "[\"localFiles\"]",
                "[]",
                deviceId,
                Jarvis.Domain.Tasks.WorkerKind.Codex,
                0,
                nowMs);
            task.Assign("expiry-input-owner", nowMs + 30_000, nowMs, deviceId);
            task.Start(nowMs);
            task.WaitForUserInput(nowMs);
            var execution = Jarvis.Domain.Tasks.TaskExecution.Create(
                Guid.CreateVersion7(),
                task.Id,
                deviceId,
                Jarvis.Domain.Tasks.WorkerKind.Codex,
                nowMs);
            execution.Start(nowMs);
            execution.SetCodexTurn("thread-expiry", "turn-expiry");
            execution.WaitForUserInput(nowMs);
            var request = Jarvis.Domain.Tasks.TaskUserInputRequest.Create(
                Guid.CreateVersion7(),
                task.Id,
                execution.Id,
                deviceId,
                "expire-99",
                true,
                "item-expiry",
                "thread-expiry",
                "turn-expiry",
                JsonSerializer.Serialize(new[] { new TaskUserInputQuestion("Mode", "mode", "Choose a mode") }, JsonOptions),
                nowMs,
                nowMs + 100);
            var notification = Jarvis.Domain.Notifications.Notification.Create(
                Guid.CreateVersion7(),
                userId,
                conversation.Id,
                task.Id,
                "task.needsUserInput",
                Jarvis.Domain.Notifications.NotificationSeverity.Info,
                "Input required",
                "Answer required",
                $"task:{task.Id:D}:user-input:expire-99",
                nowMs);
            db.AddRange(conversation, task, execution, request, notification);
            await db.SaveChangesAsync();
        }

        clock.Advance(TimeSpan.FromMilliseconds(101));
        await using var scope = isolated.Services.CreateAsyncScope();
        var recovered = await scope.ServiceProvider
            .GetRequiredService<Jarvis.Infrastructure.Devices.DeviceLeaseRecoveryService>()
            .RecoverExpiredAsync();
        Assert.Equal(0, recovered);
        var verification = scope.ServiceProvider.GetRequiredService<JarvisDbContext>();
        Assert.Equal(DomainTaskUserInputStatus.Expired, await verification.TaskUserInputRequests.Select(item => item.Status).SingleAsync());
        Assert.Equal(DomainTaskStatus.Failed, await verification.Tasks.Select(item => item.Status).SingleAsync());
        Assert.Equal(DomainTaskExecutionStatus.Failed, await verification.TaskExecutions.Select(item => item.Status).SingleAsync());
        Assert.Equal(
            DomainNotificationStatus.Actioned,
            await verification.Notifications
                .Where(item => item.Type == "task.needsUserInput")
                .Select(item => item.Status)
                .SingleAsync());
        Assert.Contains("task.failed", await verification.Notifications.Select(item => item.Type).ToListAsync());
        Assert.Contains("task.userInputExpired", await verification.TaskEvents.Select(item => item.EventType).ToListAsync());
        Assert.Contains("notification.updated", await verification.OutboxMessages.Select(item => item.EventType).ToListAsync());
        Assert.Contains(
            await verification.OutboxMessages.Where(item => item.EventType == "notification.created").Select(item => item.PayloadJson).ToListAsync(),
            payload => payload.Contains("task.failed", StringComparison.Ordinal));
    }

    [Fact]
    public async Task ExpiredCancellationLeaseIsFinalizedWithCancelledTaskAndExecution()
    {
        var clock = new AdvancingTimeProvider(new DateTimeOffset(2030, 1, 2, 3, 4, 5, TimeSpan.Zero));
        await using var isolated = new TestApplicationFactory(
            databasePath: null,
            deleteDatabaseOnDispose: true,
            outboxPublisher: null,
            timeProvider: clock);
        Guid taskId;
        Guid executionId;
        await using (var setupScope = isolated.Services.CreateAsyncScope())
        {
            var db = setupScope.ServiceProvider.GetRequiredService<JarvisDbContext>();
            var nowMs = clock.GetUtcNow().ToUnixTimeMilliseconds();
            var userId = await db.Users.Select(item => item.Id).SingleAsync();
            var deviceId = await db.Devices.Select(item => item.Id).FirstAsync();
            var conversation = Jarvis.Domain.Conversations.Conversation.Create(
                Guid.CreateVersion7(), userId, "Cancellation expiry", nowMs);
            taskId = Guid.CreateVersion7();
            var task = Jarvis.Domain.Tasks.Task.Create(
                taskId,
                userId,
                conversation.Id,
                "cancel after losing the node",
                null,
                "[\"localFiles\"]",
                "[]",
                deviceId,
                Jarvis.Domain.Tasks.WorkerKind.Codex,
                0,
                nowMs);
            task.Assign("cancel-expiry-owner", nowMs + 100, nowMs, deviceId);
            task.Start(nowMs);
            task.WaitForUserInput(nowMs);
            Assert.True(task.RequestCancellation(nowMs + 1));
            var execution = Jarvis.Domain.Tasks.TaskExecution.Create(
                Guid.CreateVersion7(), task.Id, deviceId,
                Jarvis.Domain.Tasks.WorkerKind.Codex, nowMs);
            executionId = execution.Id;
            execution.Start(nowMs);
            execution.SetCodexTurn("cancel-expiry-thread", "cancel-expiry-turn");
            execution.WaitForUserInput(nowMs);
            var request = Jarvis.Domain.Tasks.TaskUserInputRequest.Create(
                Guid.CreateVersion7(), task.Id, execution.Id, deviceId,
                "cancel-expiry-request", true, "cancel-expiry-item", "cancel-expiry-thread", "cancel-expiry-turn",
                JsonSerializer.Serialize(new[] { new TaskUserInputQuestion("Mode", "mode", "Choose") }, JsonOptions),
                nowMs, nowMs + 10_000);
            var notification = Jarvis.Domain.Notifications.Notification.Create(
                Guid.CreateVersion7(), userId, conversation.Id, task.Id,
                "task.needsUserInput", Jarvis.Domain.Notifications.NotificationSeverity.Info,
                "Input required", "Answer required",
                $"task:{task.Id:D}:user-input:cancel-expiry-request", nowMs);
            db.AddRange(conversation, task, execution, request, notification);
            await db.SaveChangesAsync();
        }

        await using (var beforeRecoveryScope = isolated.Services.CreateAsyncScope())
        {
            var beforeRecoveryDb = beforeRecoveryScope.ServiceProvider.GetRequiredService<JarvisDbContext>();
            var beforeRecoveryTask = await beforeRecoveryDb.Tasks.Where(item => item.Id == taskId).SingleAsync();
            Assert.Equal(DomainTaskStatus.CancellationRequested, beforeRecoveryTask.Status);
            Assert.Equal(clock.GetUtcNow().ToUnixTimeMilliseconds() + 100, beforeRecoveryTask.LeaseExpiresAtMs);
        }

        clock.Advance(TimeSpan.FromMilliseconds(101));
        await using var recoveryScope = isolated.Services.CreateAsyncScope();
        var beforeRecovery = recoveryScope.ServiceProvider.GetRequiredService<JarvisDbContext>();
        var persistedBeforeRecovery = await beforeRecovery.Tasks.Where(item => item.Id == taskId).SingleAsync();
        Assert.Equal(DomainTaskStatus.CancellationRequested, persistedBeforeRecovery.Status);
        Assert.True(persistedBeforeRecovery.LeaseExpiresAtMs <= clock.GetUtcNow().ToUnixTimeMilliseconds());
        var recovered = await recoveryScope.ServiceProvider
            .GetRequiredService<Jarvis.Infrastructure.Devices.DeviceLeaseRecoveryService>()
            .RecoverExpiredAsync();
        Assert.Equal(1, recovered);
        var verification = recoveryScope.ServiceProvider.GetRequiredService<JarvisDbContext>();
        Assert.Equal(DomainTaskStatus.Cancelled, await verification.Tasks.Where(item => item.Id == taskId).Select(item => item.Status).SingleAsync());
        Assert.Equal(DomainTaskExecutionStatus.Cancelled, await verification.TaskExecutions.Where(item => item.Id == executionId).Select(item => item.Status).SingleAsync());
        Assert.Equal(DomainTaskUserInputStatus.Cleared, await verification.TaskUserInputRequests.Where(item => item.ExecutionId == executionId).Select(item => item.Status).SingleAsync());
        Assert.Equal(DomainNotificationStatus.Actioned, await verification.Notifications.Where(item => item.TaskId == taskId && item.Type == "task.needsUserInput").Select(item => item.Status).SingleAsync());
        Assert.Contains("task.cancelled", await verification.TaskEvents.Where(item => item.TaskId == taskId).Select(item => item.EventType).ToListAsync());
        Assert.Contains("task.cancelled", await verification.OutboxMessages.Select(item => item.EventType).ToListAsync());
        Assert.Contains("notification.updated", await verification.OutboxMessages.Select(item => item.EventType).ToListAsync());
        Assert.Contains("task.cancelled", await verification.Notifications.Where(item => item.TaskId == taskId).Select(item => item.Type).ToListAsync());
        Assert.Contains(
            await verification.OutboxMessages.Where(item => item.EventType == "notification.created").Select(item => item.PayloadJson).ToListAsync(),
            payload => payload.Contains("task.cancelled", StringComparison.Ordinal));
    }

    [Fact]
    public async Task CancellationRequestedLeaseCanStillBeRenewedByItsWorker()
    {
        var clock = new AdvancingTimeProvider(new DateTimeOffset(2030, 1, 2, 3, 4, 5, TimeSpan.Zero));
        await using var isolated = new TestApplicationFactory(
            databasePath: null,
            deleteDatabaseOnDispose: true,
            outboxPublisher: null,
            timeProvider: clock);
        using var ui = isolated.CreateClient();
        ui.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", isolated.Token);
        var conversationId = await CreateConversationAsync(ui);
        var taskId = await CreateTaskAsync(ui, conversationId, "renew during cancellation");

        using var registration = new HttpRequestMessage(HttpMethod.Post, "/api/v1/devices/register")
        {
            Content = JsonContent.Create(new DeviceRegistrationRequest(
                "Cancellation renewal node",
                DeviceTypeValue.Desktop,
                "macos",
                ["localFiles", "deepReasoning"],
                [Path.GetTempPath()]))
        };
        registration.Headers.Add("Idempotency-Key", "cancellation-renew-register");
        using var registrationResponse = await ui.SendAsync(registration);
        registrationResponse.EnsureSuccessStatusCode();
        var device = (await registrationResponse.Content.ReadFromJsonAsync<DeviceRegistrationResponse>(JsonOptions))!;

        using var node = isolated.CreateClient();
        node.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", device.DeviceCredential);
        using (var heartbeat = new HttpRequestMessage(HttpMethod.Post, $"/api/v1/devices/{device.DeviceId:D}/heartbeat")
        {
            Content = JsonContent.Create(new DeviceHeartbeatRequest(["localFiles", "deepReasoning"], [Path.GetTempPath()]))
        })
        {
            heartbeat.Headers.Add("Idempotency-Key", "cancellation-renew-heartbeat");
            (await node.SendAsync(heartbeat)).EnsureSuccessStatusCode();
        }

        using var claim = new HttpRequestMessage(HttpMethod.Post, "/api/v1/device-tasks/claim")
        {
            Content = JsonContent.Create(new DeviceTaskClaimRequest(
                "cancellation-renew-owner",
                new CapabilityEnvelopeContract(ReadFiles: true, AllowedRoots: [Path.GetTempPath()])))
        };
        claim.Headers.Add("Idempotency-Key", "cancellation-renew-claim");
        using var claimResponse = await node.SendAsync(claim);
        claimResponse.EnsureSuccessStatusCode();
        var claimed = (await claimResponse.Content.ReadFromJsonAsync<DeviceTaskClaimResponse>(JsonOptions))!;

        using var cancel = new HttpRequestMessage(HttpMethod.Post, $"/api/v1/tasks/{taskId:D}/cancel");
        cancel.Headers.Add("Authorization", $"Bearer {isolated.Token}");
        cancel.Headers.Add("Idempotency-Key", "cancellation-renew-cancel");
        using var cancelResponse = await ui.SendAsync(cancel);
        cancelResponse.EnsureSuccessStatusCode();

        node.DefaultRequestHeaders.Add("X-Lease-Owner", claimed.LeaseOwner);
        using var renew = new HttpRequestMessage(HttpMethod.Post, $"/api/v1/device-tasks/{taskId:D}/lease:renew")
        {
            Content = JsonContent.Create(new DeviceTaskLeaseRenewRequest("cancellation-renew-owner"))
        };
        renew.Headers.Add("Idempotency-Key", "cancellation-renew-after-cancel");
        using var renewResponse = await node.SendAsync(renew);
        Assert.Equal(HttpStatusCode.OK, renewResponse.StatusCode);
        var renewed = await renewResponse.Content.ReadFromJsonAsync<DeviceTaskLeaseRenewResponse>(JsonOptions);
        Assert.True(renewed!.Renewed);
        Assert.Equal(TaskStatusValue.CancellationRequested, renewed.Status);
    }

    [Fact]
    public async Task CancellingWaitingUserInputClearsTheRequestAndActionsItsNotification()
    {
        var nowMs = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        var taskId = Guid.CreateVersion7();
        var requestId = "cancel-input";
        Guid executionId;
        await using (var setupScope = factory.Services.CreateAsyncScope())
        {
            var db = setupScope.ServiceProvider.GetRequiredService<JarvisDbContext>();
            var userId = await db.Users.Select(item => item.Id).SingleAsync();
            var deviceId = await db.Devices.Select(item => item.Id).FirstAsync();
            var conversation = Jarvis.Domain.Conversations.Conversation.Create(
                Guid.CreateVersion7(), userId, "Cancellation", nowMs);
            var task = Jarvis.Domain.Tasks.Task.Create(
                taskId,
                userId,
                conversation.Id,
                "cancel a waiting input",
                null,
                "[\"localFiles\"]",
                "[]",
                deviceId,
                Jarvis.Domain.Tasks.WorkerKind.Codex,
                0,
                nowMs);
            task.Assign("cancel-input-owner", nowMs + 30_000, nowMs, deviceId);
            task.Start(nowMs);
            task.WaitForUserInput(nowMs);
            var execution = Jarvis.Domain.Tasks.TaskExecution.Create(
                Guid.CreateVersion7(), task.Id, deviceId,
                Jarvis.Domain.Tasks.WorkerKind.Codex, nowMs);
            executionId = execution.Id;
            execution.Start(nowMs);
            execution.SetCodexTurn("thread-cancel", "turn-cancel");
            execution.WaitForUserInput(nowMs);
            var request = Jarvis.Domain.Tasks.TaskUserInputRequest.Create(
                Guid.CreateVersion7(), task.Id, execution.Id, deviceId,
                requestId, true, "item-cancel", "thread-cancel", "turn-cancel",
                JsonSerializer.Serialize(new[] { new TaskUserInputQuestion("Mode", "mode", "Choose") }, JsonOptions),
                nowMs, nowMs + 30_000);
            var notification = Jarvis.Domain.Notifications.Notification.Create(
                Guid.CreateVersion7(), userId, conversation.Id, task.Id,
                "task.needsUserInput", Jarvis.Domain.Notifications.NotificationSeverity.Info,
                "Input required", "Answer required",
                $"task:{task.Id:D}:user-input:{requestId}", nowMs);
            db.AddRange(conversation, task, execution, request, notification);
            await db.SaveChangesAsync();
        }

        using var client = factory.CreateClient();
        client.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", factory.Token);
        using var response = await SendCancelAsync(client, taskId, $"cancel-input-{Guid.CreateVersion7():N}");
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        var cancelled = await response.Content.ReadFromJsonAsync<TaskCancelResponse>();
        Assert.Equal(TaskStatusValue.CancellationRequested, cancelled!.Status);

        await using var verificationScope = factory.Services.CreateAsyncScope();
        var verification = verificationScope.ServiceProvider.GetRequiredService<JarvisDbContext>();
        Assert.Equal(DomainTaskUserInputStatus.Cleared, await verification.TaskUserInputRequests.Where(item => item.ExecutionId == executionId).Select(item => item.Status).SingleAsync());
        Assert.Equal(DomainNotificationStatus.Actioned, await verification.Notifications.Where(item => item.TaskId == taskId).Select(item => item.Status).SingleAsync());
        Assert.Contains("notification.updated", await verification.OutboxMessages.Where(item => item.EventType == "notification.updated").Select(item => item.EventType).ToListAsync());
    }

    [Fact]
    public async Task ReclaimingExpiredLeaseWithPendingInputKeepsWaitingAndCanResumeTheSameExecution()
    {
        var clock = new AdvancingTimeProvider(new DateTimeOffset(2030, 1, 2, 3, 4, 5, TimeSpan.Zero));
        await using var isolated = new TestApplicationFactory(
            databasePath: null,
            deleteDatabaseOnDispose: true,
            outboxPublisher: null,
            timeProvider: clock);
        using var ui = isolated.CreateClient();
        ui.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", isolated.Token);
        var conversationId = await CreateConversationAsync(ui);
        var taskId = await CreateTaskAsync(ui, conversationId, "recover a waiting user input");

        using var registration = new HttpRequestMessage(HttpMethod.Post, "/api/v1/devices/register")
        {
            Content = JsonContent.Create(new DeviceRegistrationRequest(
                "Recovery input node",
                DeviceTypeValue.Desktop,
                "macos",
                ["localFiles", "deepReasoning"],
                [Path.GetTempPath()]))
        };
        registration.Headers.Add("Idempotency-Key", "recovery-input-register");
        using var registrationResponse = await ui.SendAsync(registration);
        registrationResponse.EnsureSuccessStatusCode();
        var device = (await registrationResponse.Content.ReadFromJsonAsync<DeviceRegistrationResponse>(JsonOptions))!;

        using var node = isolated.CreateClient();
        node.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", device.DeviceCredential);
        using (var heartbeat = new HttpRequestMessage(HttpMethod.Post, $"/api/v1/devices/{device.DeviceId:D}/heartbeat")
        {
            Content = JsonContent.Create(new DeviceHeartbeatRequest(["localFiles", "deepReasoning"], [Path.GetTempPath()]))
        })
        {
            heartbeat.Headers.Add("Idempotency-Key", "recovery-input-heartbeat");
            (await node.SendAsync(heartbeat)).EnsureSuccessStatusCode();
        }

        using var claim = new HttpRequestMessage(HttpMethod.Post, "/api/v1/device-tasks/claim")
        {
            Content = JsonContent.Create(new DeviceTaskClaimRequest(
                "recovery-input-owner",
                new CapabilityEnvelopeContract(ReadFiles: true, AllowedRoots: [Path.GetTempPath()])))
        };
        claim.Headers.Add("Idempotency-Key", "recovery-input-claim");
        var initialClaimResponse = await node.SendAsync(claim);
        initialClaimResponse.EnsureSuccessStatusCode();
        var initialClaim = (await initialClaimResponse.Content.ReadFromJsonAsync<DeviceTaskClaimResponse>(JsonOptions))!;
        Assert.True(initialClaim.Claimed);

        node.DefaultRequestHeaders.Add("X-Lease-Owner", initialClaim.LeaseOwner);
        await AppendDeviceEventAsync(
            node,
            taskId,
            new DeviceTaskEventRequest(
                "recovery-input-turn-starting",
                initialClaim.Execution!.Id,
                "codex.turn.starting",
                CodexThreadId: "recovery-input-thread"),
            "recovery-input-turn-starting-key");
        await AppendDeviceEventAsync(
            node,
            taskId,
            new DeviceTaskEventRequest(
                "recovery-input-turn-started",
                initialClaim.Execution.Id,
                "codex.turn.started",
                CodexThreadId: "recovery-input-thread",
                CodexTurnId: "recovery-input-turn"),
            "recovery-input-turn-started-key");

        using var input = new HttpRequestMessage(HttpMethod.Post, $"/api/v1/device-tasks/{taskId:D}/user-input")
        {
            Content = JsonContent.Create(new DeviceTaskUserInputRequest(
                initialClaim.Execution.Id,
                "recovery-input-request",
                "recovery-input-item",
                [new TaskUserInputQuestion("Mode", "mode", "Choose a mode")],
                "recovery-input-thread",
                "recovery-input-turn",
                AutoResolutionMs: 60_000))
        };
        input.Headers.Add("Idempotency-Key", "recovery-input-request-key");
        var inputResponse = await node.SendAsync(input);
        inputResponse.EnsureSuccessStatusCode();

        clock.Advance(TimeSpan.FromSeconds(31));
        await using (var recoveryScope = isolated.Services.CreateAsyncScope())
        {
            var recovered = await recoveryScope.ServiceProvider
                .GetRequiredService<Jarvis.Infrastructure.Devices.DeviceLeaseRecoveryService>()
                .RecoverExpiredAsync();
            Assert.Equal(1, recovered);
            var db = recoveryScope.ServiceProvider.GetRequiredService<JarvisDbContext>();
            Assert.Equal(DomainTaskStatus.Recovering, await db.Tasks.Where(item => item.Id == taskId).Select(item => item.Status).SingleAsync());
            Assert.Equal(DomainTaskExecutionStatus.Recovering, await db.TaskExecutions.Where(item => item.Id == initialClaim.Execution.Id).Select(item => item.Status).SingleAsync());
            Assert.Equal(DomainTaskUserInputStatus.Pending, await db.TaskUserInputRequests.Where(item => item.ExecutionId == initialClaim.Execution.Id).Select(item => item.Status).SingleAsync());
            var recoveringOutbox = await db.OutboxMessages
                .Where(item => item.EventType == "task.updated")
                .Select(item => item.PayloadJson)
                .ToListAsync();
            var recoveringPayload = recoveringOutbox
                .Select(item => JsonDocument.Parse(item).RootElement.Clone())
                .Where(item => item.GetProperty("payload").GetProperty("taskId").GetGuid() == taskId
                    && item.GetProperty("payload").GetProperty("eventType").GetString() == "task.recovering")
                .Select(item => item.GetProperty("payload"))
                .Single();
            Assert.True(recoveringPayload.TryGetProperty("pendingUserInput", out var recoveringPending));
            Assert.Equal(JsonValueKind.Null, recoveringPending.ValueKind);
        }

        var recoveringTask = await ui.GetFromJsonAsync<TaskResponse>($"/api/v1/tasks/{taskId:D}");
        Assert.Equal(TaskStatusValue.Recovering, recoveringTask!.Status);
        Assert.Null(recoveringTask.PendingUserInput);
        var recoveringList = await ui.GetFromJsonAsync<TaskListResponse>("/api/v1/tasks");
        var recoveringListTask = Assert.Single(recoveringList!.Items, item => item.Id == taskId);
        Assert.Equal(TaskStatusValue.Recovering, recoveringListTask.Status);
        Assert.Null(recoveringListTask.PendingUserInput);

        using (var heartbeat = new HttpRequestMessage(HttpMethod.Post, $"/api/v1/devices/{device.DeviceId:D}/heartbeat")
        {
            Content = JsonContent.Create(new DeviceHeartbeatRequest(["localFiles", "deepReasoning"], [Path.GetTempPath()]))
        })
        {
            heartbeat.Headers.Add("Idempotency-Key", "recovery-input-heartbeat-again");
            (await node.SendAsync(heartbeat)).EnsureSuccessStatusCode();
        }

        using var reclaimedClaim = new HttpRequestMessage(HttpMethod.Post, "/api/v1/device-tasks/claim")
        {
            Content = JsonContent.Create(new DeviceTaskClaimRequest(
                "recovery-input-owner-2",
                new CapabilityEnvelopeContract(ReadFiles: true, AllowedRoots: [Path.GetTempPath()])))
        };
        reclaimedClaim.Headers.Add("Idempotency-Key", "recovery-input-claim-again");
        var reclaimedResponse = await node.SendAsync(reclaimedClaim);
        reclaimedResponse.EnsureSuccessStatusCode();
        var reclaimed = (await reclaimedResponse.Content.ReadFromJsonAsync<DeviceTaskClaimResponse>(JsonOptions))!;
        Assert.True(reclaimed.Claimed);
        Assert.Equal(TaskStatusValue.WaitingForUserInput, reclaimed.Task!.Status);
        Assert.Equal(TaskExecutionStatusValue.WaitingForUserInput, reclaimed.Execution!.Status);
        Assert.Equal("recovery-input-request", reclaimed.Task.PendingUserInput!.RequestId);

        await using (var claimOutboxScope = isolated.Services.CreateAsyncScope())
        {
            var db = claimOutboxScope.ServiceProvider.GetRequiredService<JarvisDbContext>();
            var claimOutbox = await db.OutboxMessages
                .Where(item => item.EventType == "task.updated" || item.EventType == "task.eventAdded")
                .Select(item => item.PayloadJson)
                .ToListAsync();
            var claimPayload = claimOutbox
                .Select(item => JsonDocument.Parse(item).RootElement.Clone())
                .Where(item => item.GetProperty("payload").GetProperty("taskId").GetGuid() == taskId
                    && item.GetProperty("payload").GetProperty("eventType").GetString() == "task.claimed"
                    && item.GetProperty("payload").GetProperty("status").GetString() == "waitingForUserInput")
                .Select(item => item.GetProperty("payload"))
                .OrderByDescending(item => item.GetProperty("entityVersion").GetInt64())
                .First();
            Assert.Equal(reclaimed.Task.EntityVersion, claimPayload.GetProperty("entityVersion").GetInt64());
            var claimPending = claimPayload.GetProperty("pendingUserInput");
            Assert.Equal("recovery-input-request", claimPending.GetProperty("requestId").GetString());
            Assert.False(claimPending.TryGetProperty("answers", out _));
        }

        using var answer = new HttpRequestMessage(HttpMethod.Post, $"/api/v1/tasks/{taskId:D}/user-input")
        {
            Content = JsonContent.Create(new TaskUserInputSubmissionRequest(
                "recovery-input-request",
                new Dictionary<string, TaskUserInputAnswer>
                {
                    ["mode"] = new TaskUserInputAnswer(["manual"])
                },
                reclaimed.Execution.Id))
        };
        answer.Headers.Add("Idempotency-Key", "recovery-input-answer");
        using var answerResponse = await ui.SendAsync(answer);
        Assert.Equal(HttpStatusCode.OK, answerResponse.StatusCode);
        var submitted = await answerResponse.Content.ReadFromJsonAsync<TaskUserInputSubmissionResponse>(JsonOptions);
        Assert.Equal(TaskStatusValue.Running, submitted!.Status);
        Assert.Equal(TaskExecutionStatusValue.Running, submitted.ExecutionStatus);
    }

    [Fact]
    public async Task UserInputSubmissionSameKeyIsSafeUnderSqliteConcurrencyAndRetentionReuse()
    {
        var clock = new AdvancingTimeProvider(new DateTimeOffset(2030, 1, 2, 3, 4, 5, TimeSpan.Zero));
        await using var isolated = new TestApplicationFactory(
            databasePath: null,
            deleteDatabaseOnDispose: true,
            outboxPublisher: null,
            timeProvider: clock);
        var nowMs = clock.GetUtcNow().ToUnixTimeMilliseconds();
        var taskId = Guid.CreateVersion7();
        var requestId = "concurrent-input";
        Guid userId;
        Guid deviceId;
        Guid executionId;

        await using (var setupScope = isolated.Services.CreateAsyncScope())
        {
            var db = setupScope.ServiceProvider.GetRequiredService<JarvisDbContext>();
            userId = await db.Users.Select(item => item.Id).SingleAsync();
            deviceId = await db.Devices.Select(item => item.Id).FirstAsync();
            var conversation = Jarvis.Domain.Conversations.Conversation.Create(
                Guid.CreateVersion7(), userId, "Concurrent user input", nowMs);
            var task = Jarvis.Domain.Tasks.Task.Create(
                taskId,
                userId,
                conversation.Id,
                "answer concurrently",
                null,
                "[\"localFiles\"]",
                "[]",
                deviceId,
                Jarvis.Domain.Tasks.WorkerKind.Codex,
                0,
                nowMs);
            task.Assign("concurrent-input-owner", nowMs + 30_000, nowMs, deviceId);
            task.Start(nowMs);
            task.WaitForUserInput(nowMs);
            var execution = Jarvis.Domain.Tasks.TaskExecution.Create(
                Guid.CreateVersion7(), task.Id, deviceId,
                Jarvis.Domain.Tasks.WorkerKind.Codex, nowMs);
            executionId = execution.Id;
            execution.Start(nowMs);
            execution.SetCodexTurn("concurrent-thread", "concurrent-turn");
            execution.WaitForUserInput(nowMs);
            var request = Jarvis.Domain.Tasks.TaskUserInputRequest.Create(
                Guid.CreateVersion7(), task.Id, execution.Id, deviceId,
                requestId, true, "concurrent-item", "concurrent-thread", "concurrent-turn",
                JsonSerializer.Serialize(new[] { new TaskUserInputQuestion("Mode", "mode", "Choose") }, JsonOptions),
                nowMs,
                nowMs + 60_000);
            var notification = Jarvis.Domain.Notifications.Notification.Create(
                Guid.CreateVersion7(), userId, conversation.Id, task.Id,
                "task.needsUserInput", Jarvis.Domain.Notifications.NotificationSeverity.Info,
                "Input required", "Answer required",
                $"task:{task.Id:D}:user-input:{requestId}", nowMs);
            db.AddRange(conversation, task, execution, request, notification);
            await db.SaveChangesAsync();
        }

        using var firstClient = isolated.CreateClient();
        firstClient.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", isolated.Token);
        using var secondClient = isolated.CreateClient();
        secondClient.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", isolated.Token);

        async Task<HttpResponseMessage> SubmitAsync(HttpClient client, string key, string requestKey)
        {
            using var submission = new HttpRequestMessage(HttpMethod.Post, $"/api/v1/tasks/{taskId:D}/user-input")
            {
                Content = JsonContent.Create(new TaskUserInputSubmissionRequest(
                    requestKey,
                    new Dictionary<string, TaskUserInputAnswer>
                    {
                        ["mode"] = new TaskUserInputAnswer(["manual"])
                    },
                    executionId))
            };
            submission.Headers.Add("Idempotency-Key", key);
            return await client.SendAsync(submission);
        }

        var concurrentResponses = await Task.WhenAll(
            SubmitAsync(firstClient, "same-answer-key", requestId),
            SubmitAsync(secondClient, "same-answer-key", requestId));
        try
        {
            var responseDetails = await Task.WhenAll(concurrentResponses.Select(async response =>
                $"{(int)response.StatusCode}: {await response.Content.ReadAsStringAsync()}"));
            Assert.All(concurrentResponses, response => Assert.True(response.StatusCode == HttpStatusCode.OK, string.Join(" | ", responseDetails)));
        }
        finally
        {
            foreach (var response in concurrentResponses)
            {
                response.Dispose();
            }
        }

        await using (var verificationScope = isolated.Services.CreateAsyncScope())
        {
            var db = verificationScope.ServiceProvider.GetRequiredService<JarvisDbContext>();
            var persistedRequest = await db.TaskUserInputRequests.SingleAsync(item => item.Id != Guid.Empty && item.RequestId == requestId);
            Assert.Equal(DomainTaskUserInputStatus.Answered, persistedRequest.Status);
            Assert.Contains("manual", persistedRequest.AnswersJson, StringComparison.Ordinal);
            Assert.Equal(DomainTaskStatus.Running, await db.Tasks.Where(item => item.Id == taskId).Select(item => item.Status).SingleAsync());
            Assert.Equal(DomainTaskExecutionStatus.Running, await db.TaskExecutions.Where(item => item.Id == executionId).Select(item => item.Status).SingleAsync());
            Assert.Equal(
                1,
                await db.IdempotencyRecords.CountAsync(item => item.UserId == userId && item.Scope == $"tasks:{taskId:D}:user-input" && item.IdempotencyKey == "same-answer-key"));
            var idempotency = await db.IdempotencyRecords.SingleAsync(item => item.UserId == userId && item.Scope == $"tasks:{taskId:D}:user-input" && item.IdempotencyKey == "same-answer-key");
            Assert.DoesNotContain("manual", idempotency.ResponseJson, StringComparison.Ordinal);
        }

        clock.Advance(TimeSpan.FromDays(1) + TimeSpan.FromMilliseconds(1));
        var secondRequestId = "retention-input";
        await using (var setupScope = isolated.Services.CreateAsyncScope())
        {
            var db = setupScope.ServiceProvider.GetRequiredService<JarvisDbContext>();
            var task = await db.Tasks.SingleAsync(item => item.Id == taskId);
            var secondExecution = Jarvis.Domain.Tasks.TaskExecution.Create(
                Guid.CreateVersion7(), taskId, deviceId,
                Jarvis.Domain.Tasks.WorkerKind.Codex, clock.GetUtcNow().ToUnixTimeMilliseconds());
            executionId = secondExecution.Id;
            secondExecution.Start(clock.GetUtcNow().ToUnixTimeMilliseconds());
            secondExecution.SetCodexTurn("retention-thread", "retention-turn");
            task.WaitForUserInput(clock.GetUtcNow().ToUnixTimeMilliseconds());
            secondExecution.WaitForUserInput(clock.GetUtcNow().ToUnixTimeMilliseconds());
            var secondRequest = Jarvis.Domain.Tasks.TaskUserInputRequest.Create(
                Guid.CreateVersion7(), taskId, secondExecution.Id, deviceId,
                secondRequestId, true, "retention-item", "retention-thread", "retention-turn",
                JsonSerializer.Serialize(new[] { new TaskUserInputQuestion("Mode", "mode", "Choose") }, JsonOptions),
                clock.GetUtcNow().ToUnixTimeMilliseconds(),
                clock.GetUtcNow().ToUnixTimeMilliseconds() + 60_000);
            var conversationId = task.ConversationId;
            var notification = Jarvis.Domain.Notifications.Notification.Create(
                Guid.CreateVersion7(), userId, conversationId, taskId,
                "task.needsUserInput", Jarvis.Domain.Notifications.NotificationSeverity.Info,
                "Input required", "Answer required",
                $"task:{taskId:D}:user-input:{secondRequestId}", clock.GetUtcNow().ToUnixTimeMilliseconds());
            db.AddRange(secondExecution, secondRequest, notification);
            await db.SaveChangesAsync();
        }

        await using (var preSubmitScope = isolated.Services.CreateAsyncScope())
        {
            var db = preSubmitScope.ServiceProvider.GetRequiredService<JarvisDbContext>();
            Assert.Equal(DomainTaskStatus.WaitingForUserInput, await db.Tasks.Where(item => item.Id == taskId).Select(item => item.Status).SingleAsync());
            Assert.Equal(1, await db.TaskUserInputRequests.CountAsync(item => item.TaskId == taskId && item.RequestId == secondRequestId && item.Status == DomainTaskUserInputStatus.Pending));
        }

        using var retentionResponse = await SubmitAsync(firstClient, "same-answer-key", secondRequestId);
        var retentionBody = await retentionResponse.Content.ReadAsStringAsync();
        Assert.True(retentionResponse.StatusCode == HttpStatusCode.OK, $"{(int)retentionResponse.StatusCode}: {retentionBody}");
        await using (var verificationScope = isolated.Services.CreateAsyncScope())
        {
            var db = verificationScope.ServiceProvider.GetRequiredService<JarvisDbContext>();
            Assert.Equal(DomainTaskUserInputStatus.Answered, await db.TaskUserInputRequests.Where(item => item.RequestId == secondRequestId).Select(item => item.Status).SingleAsync());
            Assert.Equal(1, await db.IdempotencyRecords.CountAsync(item => item.UserId == userId && item.Scope == $"tasks:{taskId:D}:user-input"));
        }
    }

    private static async Task AppendDeviceEventAsync(HttpClient client, Guid taskId, DeviceTaskEventRequest request, string idempotencyKey)
    {
        using var message = new HttpRequestMessage(HttpMethod.Post, $"/api/v1/device-tasks/{taskId:D}/events")
        {
            Content = JsonContent.Create(request)
        };
        message.Headers.Add("Idempotency-Key", idempotencyKey);
        using var response = await client.SendAsync(message);
        response.EnsureSuccessStatusCode();
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
                    preferredDeviceId = (Guid?)null,
                    capabilityEnvelope = TaskCapabilityEnvelope
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
                    preferredDeviceId = (Guid?)null,
                    capabilityEnvelope = TaskCapabilityEnvelope
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
                    attachmentRefs = new[] { attachmentRef },
                    capabilityEnvelope = TaskCapabilityEnvelope
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
                preferredDeviceId = (Guid?)null,
                capabilityEnvelope = TaskCapabilityEnvelope
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
                preferredDeviceId = (Guid?)null,
                capabilityEnvelope = TaskCapabilityEnvelope
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

    private sealed class AdvancingTimeProvider(DateTimeOffset initial) : TimeProvider
    {
        private DateTimeOffset now = initial;

        public override DateTimeOffset GetUtcNow() => now;

        public void Advance(TimeSpan duration) => now += duration;
    }

    private static readonly JsonSerializerOptions JsonOptions = new(JsonSerializerDefaults.Web);
}
