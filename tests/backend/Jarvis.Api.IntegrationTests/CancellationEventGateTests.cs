using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Text.Json;
using Jarvis.Contracts;
using Xunit;

namespace Jarvis.Api.IntegrationTests;

public sealed class CancellationEventGateTests : IDisposable
{
    private readonly TestApplicationFactory factory = new();

    public void Dispose() => factory.Dispose();

    [Fact]
    public async System.Threading.Tasks.Task CancellationRequestedTaskRejectsTurnStartUntilWorkerConfirmsCancellation()
    {
        using var ui = factory.CreateClient();
        UseBearer(ui, factory.Token);

        ui.DefaultRequestHeaders.Add("Idempotency-Key", "cancellation-event-gate-conversation");
        var conversationResponse = await ui.PostAsJsonAsync(
            "/api/v1/conversations",
            new CreateConversationRequest("Cancellation event gate"),
            JsonOptions);
        Assert.Equal(HttpStatusCode.Created, conversationResponse.StatusCode);
        var conversation = await conversationResponse.Content.ReadFromJsonAsync<ConversationResponse>(JsonOptions);
        Assert.NotNull(conversation);

        ui.DefaultRequestHeaders.Remove("Idempotency-Key");
        ui.DefaultRequestHeaders.Add("Idempotency-Key", "cancellation-event-gate-task");
        var taskResponse = await ui.PostAsJsonAsync(
            "/api/v1/tasks",
            new CreateTaskRequest(
                conversation!.Id,
                [],
                "run a cancellable turn",
                null,
                ["localFiles"],
                CapabilityEnvelope: new CapabilityEnvelopeContract(ReadFiles: true, AllowedRoots: [Path.GetTempPath()])),
            JsonOptions);
        Assert.Equal(HttpStatusCode.Accepted, taskResponse.StatusCode);
        var accepted = await taskResponse.Content.ReadFromJsonAsync<TaskAcceptedResponse>(JsonOptions);
        Assert.NotNull(accepted);

        ui.DefaultRequestHeaders.Remove("Idempotency-Key");
        ui.DefaultRequestHeaders.Add("Idempotency-Key", "cancellation-event-gate-device");
        var registrationResponse = await ui.PostAsJsonAsync(
            "/api/v1/devices/register",
            new DeviceRegistrationRequest("Cancellation event node", DeviceTypeValue.Desktop, "macos", ["localFiles"], [Path.GetTempPath()]),
            JsonOptions);
        Assert.Equal(HttpStatusCode.Created, registrationResponse.StatusCode);
        var device = await registrationResponse.Content.ReadFromJsonAsync<DeviceRegistrationResponse>(JsonOptions);
        Assert.NotNull(device);

        using var node = factory.CreateClient();
        UseBearer(node, device!.DeviceCredential);
        node.DefaultRequestHeaders.Add("Idempotency-Key", "cancellation-event-gate-heartbeat");
        Assert.Equal(
            HttpStatusCode.OK,
            (await node.PostAsJsonAsync(
                $"/api/v1/devices/{device.DeviceId:D}/heartbeat",
                new DeviceHeartbeatRequest(["localFiles"], [Path.GetTempPath()]),
                JsonOptions)).StatusCode);

        node.DefaultRequestHeaders.Remove("Idempotency-Key");
        node.DefaultRequestHeaders.Add("Idempotency-Key", "cancellation-event-gate-claim");
        var claimResponse = await node.PostAsJsonAsync(
            "/api/v1/device-tasks/claim",
            new DeviceTaskClaimRequest(
                "cancellation-event-owner",
                new CapabilityEnvelopeContract(ReadFiles: true, AllowedRoots: [Path.GetTempPath()])),
            JsonOptions);
        Assert.Equal(HttpStatusCode.OK, claimResponse.StatusCode);
        var claim = await claimResponse.Content.ReadFromJsonAsync<DeviceTaskClaimResponse>(JsonOptions);
        Assert.True(claim?.Claimed);
        Assert.Equal(accepted!.TaskId, claim?.Task?.Id);
        Assert.NotNull(claim?.Execution);

        ui.DefaultRequestHeaders.Remove("Idempotency-Key");
        ui.DefaultRequestHeaders.Add("Idempotency-Key", "cancellation-event-gate-cancel");
        var cancelResponse = await ui.PostAsync($"/api/v1/tasks/{accepted.TaskId:D}/cancel", content: null);
        Assert.Equal(HttpStatusCode.OK, cancelResponse.StatusCode);
        var cancelledRequest = await cancelResponse.Content.ReadFromJsonAsync<TaskCancelResponse>(JsonOptions);
        Assert.Equal(TaskStatusValue.CancellationRequested, cancelledRequest?.Status);

        node.DefaultRequestHeaders.Add("X-Lease-Owner", "cancellation-event-owner");
        node.DefaultRequestHeaders.Remove("Idempotency-Key");
        node.DefaultRequestHeaders.Add("Idempotency-Key", "cancellation-event-gate-turn-start");
        var turnStartingResponse = await node.PostAsJsonAsync(
            $"/api/v1/device-tasks/{accepted.TaskId:D}/events",
            new DeviceTaskEventRequest(
                "cancellation-event-gate-turn-start",
                claim!.Execution!.Id,
                "codex.turn.starting",
                CodexThreadId: "thread-must-not-start"),
            JsonOptions);
        Assert.Equal(HttpStatusCode.Conflict, turnStartingResponse.StatusCode);

        node.DefaultRequestHeaders.Remove("Idempotency-Key");
        node.DefaultRequestHeaders.Add("Idempotency-Key", "cancellation-event-gate-turn-started-without-intent");
        var turnStartedWithoutIntent = await node.PostAsJsonAsync(
            $"/api/v1/device-tasks/{accepted.TaskId:D}/events",
            new DeviceTaskEventRequest(
                "cancellation-event-gate-turn-started-without-intent",
                claim.Execution.Id,
                "codex.turn.started",
                CodexThreadId: "thread-must-not-start",
                CodexTurnId: "turn-must-not-start"),
            JsonOptions);
        Assert.Equal(HttpStatusCode.BadRequest, turnStartedWithoutIntent.StatusCode);

        node.DefaultRequestHeaders.Remove("Idempotency-Key");
        node.DefaultRequestHeaders.Add("Idempotency-Key", "cancellation-event-gate-confirm");
        var confirmationResponse = await node.PostAsJsonAsync(
            $"/api/v1/device-tasks/{accepted.TaskId:D}/events",
            new DeviceTaskEventRequest(
                "cancellation-event-gate-confirm",
                claim.Execution.Id,
                "task.cancelled"),
            JsonOptions);
        Assert.Equal(HttpStatusCode.OK, confirmationResponse.StatusCode);

        var persisted = await ui.GetFromJsonAsync<TaskResponse>($"/api/v1/tasks/{accepted.TaskId:D}", JsonOptions);
        Assert.Equal(TaskStatusValue.Cancelled, persisted?.Status);
        Assert.Equal(TaskExecutionStatusValue.Cancelled, persisted?.Execution?.Status);
        Assert.Null(persisted?.Execution?.CodexThreadId);
        Assert.Null(persisted?.Execution?.CodexTurnId);
    }

    [Fact]
    public async System.Threading.Tasks.Task PersistedTurnStartMayCompleteAfterCancellationButCannotCarryCompletionPayload()
    {
        using var ui = factory.CreateClient();
        UseBearer(ui, factory.Token);

        ui.DefaultRequestHeaders.Add("Idempotency-Key", "cancellation-late-start-conversation");
        var conversation = await (await ui.PostAsJsonAsync(
            "/api/v1/conversations",
            new CreateConversationRequest("Late turn start cancellation"),
            JsonOptions)).Content.ReadFromJsonAsync<ConversationResponse>(JsonOptions);
        Assert.NotNull(conversation);

        ui.DefaultRequestHeaders.Remove("Idempotency-Key");
        ui.DefaultRequestHeaders.Add("Idempotency-Key", "cancellation-late-start-task");
        var accepted = await (await ui.PostAsJsonAsync(
            "/api/v1/tasks",
            new CreateTaskRequest(
                conversation!.Id,
                [],
                "run a turn that finishes starting after cancellation",
                null,
                ["localFiles"],
                CapabilityEnvelope: new CapabilityEnvelopeContract(ReadFiles: true, AllowedRoots: [Path.GetTempPath()])),
            JsonOptions)).Content.ReadFromJsonAsync<TaskAcceptedResponse>(JsonOptions);
        Assert.NotNull(accepted);

        ui.DefaultRequestHeaders.Remove("Idempotency-Key");
        ui.DefaultRequestHeaders.Add("Idempotency-Key", "cancellation-late-start-device");
        var device = await (await ui.PostAsJsonAsync(
            "/api/v1/devices/register",
            new DeviceRegistrationRequest("Late start node", DeviceTypeValue.Desktop, "macos", ["localFiles"], [Path.GetTempPath()]),
            JsonOptions)).Content.ReadFromJsonAsync<DeviceRegistrationResponse>(JsonOptions);
        Assert.NotNull(device);

        using var node = factory.CreateClient();
        UseBearer(node, device!.DeviceCredential);
        node.DefaultRequestHeaders.Add("Idempotency-Key", "cancellation-late-start-heartbeat");
        (await node.PostAsJsonAsync(
            $"/api/v1/devices/{device.DeviceId:D}/heartbeat",
            new DeviceHeartbeatRequest(["localFiles"], [Path.GetTempPath()]),
            JsonOptions)).EnsureSuccessStatusCode();
        node.DefaultRequestHeaders.Remove("Idempotency-Key");
        node.DefaultRequestHeaders.Add("Idempotency-Key", "cancellation-late-start-claim");
        var claim = await (await node.PostAsJsonAsync(
            "/api/v1/device-tasks/claim",
            new DeviceTaskClaimRequest(
                "cancellation-late-start-owner",
                new CapabilityEnvelopeContract(ReadFiles: true, AllowedRoots: [Path.GetTempPath()])),
            JsonOptions)).Content.ReadFromJsonAsync<DeviceTaskClaimResponse>(JsonOptions);
        Assert.True(claim?.Claimed);
        Assert.Equal(accepted!.TaskId, claim?.Task?.Id);
        Assert.NotNull(claim?.Execution);

        node.DefaultRequestHeaders.Add("X-Lease-Owner", "cancellation-late-start-owner");
        node.DefaultRequestHeaders.Remove("Idempotency-Key");
        node.DefaultRequestHeaders.Add("Idempotency-Key", "cancellation-late-start-intent");
        (await node.PostAsJsonAsync(
            $"/api/v1/device-tasks/{accepted.TaskId:D}/events",
            new DeviceTaskEventRequest(
                "cancellation-late-start-intent",
                claim!.Execution!.Id,
                "codex.turn.starting",
                CodexThreadId: "late-thread"),
            JsonOptions)).EnsureSuccessStatusCode();

        ui.DefaultRequestHeaders.Remove("Idempotency-Key");
        ui.DefaultRequestHeaders.Add("Idempotency-Key", "cancellation-late-start-cancel");
        var cancelResponse = await ui.PostAsync($"/api/v1/tasks/{accepted.TaskId:D}/cancel", content: null);
        Assert.Equal(HttpStatusCode.OK, cancelResponse.StatusCode);

        node.DefaultRequestHeaders.Remove("Idempotency-Key");
        node.DefaultRequestHeaders.Add("Idempotency-Key", "cancellation-late-start-wrong-thread");
        var wrongThread = await node.PostAsJsonAsync(
            $"/api/v1/device-tasks/{accepted.TaskId:D}/events",
            new DeviceTaskEventRequest(
                "cancellation-late-start-wrong-thread",
                claim.Execution.Id,
                "codex.turn.started",
                CodexThreadId: "wrong-thread",
                CodexTurnId: "late-turn"),
            JsonOptions);
        Assert.Equal(HttpStatusCode.BadRequest, wrongThread.StatusCode);

        node.DefaultRequestHeaders.Remove("Idempotency-Key");
        node.DefaultRequestHeaders.Add("Idempotency-Key", "cancellation-late-start-payload-bypass");
        var payloadBypass = await node.PostAsJsonAsync(
            $"/api/v1/device-tasks/{accepted.TaskId:D}/events",
            new DeviceTaskEventRequest(
                "cancellation-late-start-payload-bypass",
                claim.Execution.Id,
                "codex.turn.started",
                ResultSummary: "must not complete",
                Artifacts: [new ArtifactManifestEntry(Path.Combine(Path.GetTempPath(), "not-created"), 0, new string('0', 64))],
                CodexThreadId: "late-thread",
                CodexTurnId: "late-turn"),
            JsonOptions);
        Assert.Equal(HttpStatusCode.Conflict, payloadBypass.StatusCode);

        node.DefaultRequestHeaders.Remove("Idempotency-Key");
        node.DefaultRequestHeaders.Add("Idempotency-Key", "cancellation-late-start-complete");
        var started = await node.PostAsJsonAsync(
            $"/api/v1/device-tasks/{accepted.TaskId:D}/events",
            new DeviceTaskEventRequest(
                "cancellation-late-start-complete",
                claim.Execution.Id,
                "codex.turn.started",
                CodexThreadId: "late-thread",
                CodexTurnId: "late-turn"),
            JsonOptions);
        Assert.Equal(HttpStatusCode.OK, started.StatusCode);

        var waitingForCancellation = await ui.GetFromJsonAsync<TaskResponse>($"/api/v1/tasks/{accepted.TaskId:D}", JsonOptions);
        Assert.Equal(TaskStatusValue.CancellationRequested, waitingForCancellation?.Status);
        Assert.Equal("late-thread", waitingForCancellation?.Execution?.CodexThreadId);
        Assert.Equal("late-turn", waitingForCancellation?.Execution?.CodexTurnId);

        node.DefaultRequestHeaders.Remove("Idempotency-Key");
        node.DefaultRequestHeaders.Add("Idempotency-Key", "cancellation-late-start-second-turn");
        var secondStarted = await node.PostAsJsonAsync(
            $"/api/v1/device-tasks/{accepted.TaskId:D}/events",
            new DeviceTaskEventRequest(
                "cancellation-late-start-second-turn",
                claim.Execution.Id,
                "codex.turn.started",
                CodexThreadId: "late-thread",
                CodexTurnId: "late-second-turn"),
            JsonOptions);
        Assert.Equal(HttpStatusCode.Conflict, secondStarted.StatusCode);

        var afterSecondStarted = await ui.GetFromJsonAsync<TaskResponse>($"/api/v1/tasks/{accepted.TaskId:D}", JsonOptions);
        Assert.Equal("late-turn", afterSecondStarted?.Execution?.CodexTurnId);

        node.DefaultRequestHeaders.Remove("Idempotency-Key");
        node.DefaultRequestHeaders.Add("Idempotency-Key", "cancellation-late-start-confirm");
        var confirmation = await node.PostAsJsonAsync(
            $"/api/v1/device-tasks/{accepted.TaskId:D}/events",
            new DeviceTaskEventRequest(
                "cancellation-late-start-confirm",
                claim.Execution.Id,
                "task.cancelled"),
            JsonOptions);
        Assert.Equal(HttpStatusCode.OK, confirmation.StatusCode);

        var cancelled = await ui.GetFromJsonAsync<TaskResponse>($"/api/v1/tasks/{accepted.TaskId:D}", JsonOptions);
        Assert.Equal(TaskStatusValue.Cancelled, cancelled?.Status);
        Assert.Equal(TaskExecutionStatusValue.Cancelled, cancelled?.Execution?.Status);
    }

    private static void UseBearer(HttpClient client, string token) =>
        client.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", token);

    private static readonly JsonSerializerOptions JsonOptions = new(JsonSerializerDefaults.Web);
}
