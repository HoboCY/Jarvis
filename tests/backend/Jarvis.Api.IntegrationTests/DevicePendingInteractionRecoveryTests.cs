using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Text.Json;
using Jarvis.Application.Devices;
using Jarvis.Contracts;
using Jarvis.Infrastructure.Data;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Xunit;
using InputStatus = Jarvis.Domain.Tasks.TaskUserInputRequestStatus;
using NotificationStatus = Jarvis.Domain.Notifications.NotificationStatus;
using TaskStatus = Jarvis.Domain.Tasks.TaskStatus;
using ExecutionStatus = Jarvis.Domain.Tasks.TaskExecutionStatus;

namespace Jarvis.Api.IntegrationTests;

public sealed class DevicePendingInteractionRecoveryTests
{
    private static readonly JsonSerializerOptions JsonOptions = new(JsonSerializerDefaults.Web);

    [Theory]
    [InlineData(false, false)]
    [InlineData(true, false)]
    [InlineData(false, true)]
    public async Task RecoveryFailureAtomicallyTerminatesTheExecutionAndRemovesTheInputAction(bool alreadyAnswered, bool expired)
    {
        await using var factory = new TestApplicationFactory();
        var taskId = Guid.CreateVersion7();
        var executionId = Guid.CreateVersion7();
        Guid deviceId;
        await using (var setup = factory.Services.CreateAsyncScope())
        {
            var db = setup.ServiceProvider.GetRequiredService<JarvisDbContext>();
            var now = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() - 1_000;
            var userId = await db.Users.Select(item => item.Id).SingleAsync();
            deviceId = await db.Devices.Select(item => item.Id).FirstAsync();
            var conversation = Jarvis.Domain.Conversations.Conversation.Create(
                Guid.CreateVersion7(), userId, "Input recovery", now);
            var task = Jarvis.Domain.Tasks.Task.Create(taskId, userId, conversation.Id,
                "Recover the original native interaction", null, "[\"localFiles\"]", "[]",
                deviceId, Jarvis.Domain.Tasks.WorkerKind.Codex, 0, now);
            task.Assign("input-recovery-owner", now + 30_000, now, deviceId);
            task.Start(now);
            task.WaitForUserInput(now);
            var execution = Jarvis.Domain.Tasks.TaskExecution.Create(executionId, taskId, deviceId,
                Jarvis.Domain.Tasks.WorkerKind.Codex, now);
            execution.Start(now);
            execution.SetCodexTurn("original-thread", "original-turn");
            execution.WaitForUserInput(now);
            var input = Jarvis.Domain.Tasks.TaskUserInputRequest.Create(Guid.CreateVersion7(), taskId,
                executionId, deviceId, "99", false, "original-item", "original-thread", "original-turn",
                JsonSerializer.Serialize(new[] { new TaskUserInputQuestion("Choice", "choice", "Choose") },
                    JsonOptions), now, expired ? now + 100 : null);
            var notification = Jarvis.Domain.Notifications.Notification.Create(Guid.CreateVersion7(), userId,
                conversation.Id, taskId, "task.needsUserInput", Jarvis.Domain.Notifications.NotificationSeverity.Info,
                "Input required", "Choose an option", $"task:{taskId:D}:user-input:99", now);
            if (alreadyAnswered)
            {
                input.Answer("{\"choice\":{\"answers\":[\"alpha\"]}}", now);
                task.Resume(now);
                execution.Resume(now);
                notification.MarkActioned(now);
            }
            db.AddRange(conversation, task, execution, input, notification);
            await db.SaveChangesAsync();
        }

        var failure = new DeviceTaskEventRequest($"codex-failed:{executionId:D}", executionId, "task.failed",
            PayloadJson: "{\"reason\":\"CODEX_PENDING_INTERACTION_NOT_RESUMABLE\"}",
            ErrorCode: "CODEX_PENDING_INTERACTION_NOT_RESUMABLE",
            ErrorMessage: "The original native interaction cannot be safely resumed.");
        await using (var action = factory.Services.CreateAsyncScope())
        {
            var store = action.ServiceProvider.GetRequiredService<IDeviceStore>();
            var recoverable = await store.GetTaskAsync(deviceId, taskId, CancellationToken.None);
            Assert.Equal(alreadyAnswered ? TaskUserInputStatusValue.Answered : TaskUserInputStatusValue.Pending,
                recoverable.Value!.PendingUserInput?.Status);
            Assert.Equal("original-turn", recoverable.Value.PendingUserInput!.TurnId);
            var failed = await store.AppendEventAsync(deviceId, taskId, failure, "input-recovery-owner",
                "input-recovery-failed", CancellationToken.None);
            Assert.Equal(DeviceOperationStatus.Succeeded, failed.Status);
            Assert.Equal(TaskStatusValue.Failed, failed.Value!.Status);
            Assert.Equal(TaskExecutionStatusValue.Failed, failed.Value.ExecutionStatus);
        }

        await using var verification = factory.Services.CreateAsyncScope();
        var database = verification.ServiceProvider.GetRequiredService<JarvisDbContext>();
        Assert.Equal(TaskStatus.Failed, await database.Tasks.Where(item => item.Id == taskId).Select(item => item.Status).SingleAsync());
        Assert.Equal(ExecutionStatus.Failed, await database.TaskExecutions.Where(item => item.Id == executionId).Select(item => item.Status).SingleAsync());
        Assert.Equal(alreadyAnswered ? InputStatus.Answered : InputStatus.Cleared,
            await database.TaskUserInputRequests.Where(item => item.ExecutionId == executionId).Select(item => item.Status).SingleAsync());
        Assert.Equal(NotificationStatus.Actioned, await database.Notifications
            .Where(item => item.TaskId == taskId && item.Type == "task.needsUserInput").Select(item => item.Status).SingleAsync());
        Assert.Single(await database.TaskEvents.Where(item => item.TaskId == taskId && item.EventType == "task.failed").ToListAsync());
        if (!alreadyAnswered)
        {
            Assert.Contains(await database.OutboxMessages.Where(item => item.EventType == "notification.updated")
                .Select(item => item.PayloadJson).ToListAsync(), payload => payload.Contains(taskId.ToString(), StringComparison.Ordinal));
        }
        var replay = await verification.ServiceProvider.GetRequiredService<IDeviceStore>().AppendEventAsync(
            deviceId, taskId, failure, "input-recovery-owner", "input-recovery-failed", CancellationToken.None);
        Assert.Equal(DeviceOperationStatus.Replayed, replay.Status);

        using var ui = factory.CreateClient();
        ui.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", factory.Token);
        var restored = await ui.GetFromJsonAsync<TaskResponse>($"/api/v1/tasks/{taskId:D}");
        Assert.Equal(TaskStatusValue.Failed, restored!.Status);
        Assert.Equal("CODEX_PENDING_INTERACTION_NOT_RESUMABLE", restored.ErrorCode);
        Assert.Null(restored.PendingUserInput);
        var deviceRestored = await verification.ServiceProvider.GetRequiredService<IDeviceStore>()
            .GetTaskAsync(deviceId, taskId, CancellationToken.None);
        Assert.Null(deviceRestored.Value!.PendingUserInput);
    }
}
