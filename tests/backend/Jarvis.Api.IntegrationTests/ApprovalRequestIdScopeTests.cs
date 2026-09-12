using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Text.Json;
using Jarvis.Contracts;
using Xunit;

namespace Jarvis.Api.IntegrationTests;

public sealed class ApprovalRequestIdScopeTests : IDisposable
{
    private readonly TestApplicationFactory factory = new();

    public void Dispose() => factory.Dispose();

    [Fact]
    public async System.Threading.Tasks.Task NativeRequestIdCanRepeatAcrossExecutionsButRemainsReplayScopedWithinOneExecution()
    {
        using var ui = factory.CreateClient();
        UseBearer(ui, factory.Token);

        ui.DefaultRequestHeaders.Add("Idempotency-Key", "approval-request-id-scope-conversation");
        var conversationResponse = await ui.PostAsJsonAsync(
            "/api/v1/conversations",
            new CreateConversationRequest("Approval request ID scope"),
            JsonOptions);
        Assert.Equal(HttpStatusCode.Created, conversationResponse.StatusCode);
        var conversation = await conversationResponse.Content.ReadFromJsonAsync<ConversationResponse>(JsonOptions);
        Assert.NotNull(conversation);

        var firstTask = await CreateTaskAsync(ui, conversation!.Id, "first approval execution");
        var secondTask = await CreateTaskAsync(ui, conversation.Id, "second approval execution");

        ui.DefaultRequestHeaders.Remove("Idempotency-Key");
        ui.DefaultRequestHeaders.Add("Idempotency-Key", "approval-request-id-scope-device");
        var registrationResponse = await ui.PostAsJsonAsync(
            "/api/v1/devices/register",
            new DeviceRegistrationRequest("Approval scope node", DeviceTypeValue.Desktop, "macos", ["localFiles"], [Path.GetTempPath()]),
            JsonOptions);
        Assert.Equal(HttpStatusCode.Created, registrationResponse.StatusCode);
        var device = await registrationResponse.Content.ReadFromJsonAsync<DeviceRegistrationResponse>(JsonOptions);
        Assert.NotNull(device);

        using var node = factory.CreateClient();
        UseBearer(node, device!.DeviceCredential);
        node.DefaultRequestHeaders.Add("Idempotency-Key", "approval-request-id-scope-heartbeat");
        Assert.Equal(
            HttpStatusCode.OK,
            (await node.PostAsJsonAsync(
                $"/api/v1/devices/{device.DeviceId:D}/heartbeat",
                new DeviceHeartbeatRequest(["localFiles"], [Path.GetTempPath()]),
                JsonOptions)).StatusCode);

        node.DefaultRequestHeaders.Remove("Idempotency-Key");
        node.DefaultRequestHeaders.Add("Idempotency-Key", "approval-request-id-scope-claim-one");
        var firstClaimResponse = await node.PostAsJsonAsync(
            "/api/v1/device-tasks/claim",
            new DeviceTaskClaimRequest(
                "approval-scope-owner",
                new CapabilityEnvelopeContract(ReadFiles: true, AllowedRoots: [Path.GetTempPath()])),
            JsonOptions);
        Assert.Equal(HttpStatusCode.OK, firstClaimResponse.StatusCode);
        var firstClaim = await firstClaimResponse.Content.ReadFromJsonAsync<DeviceTaskClaimResponse>(JsonOptions);
        Assert.True(firstClaim?.Claimed);
        Assert.Equal(firstTask.TaskId, firstClaim?.Task?.Id);
        Assert.NotNull(firstClaim?.Execution);

        node.DefaultRequestHeaders.Add("X-Lease-Owner", "approval-scope-owner");
        node.DefaultRequestHeaders.Remove("Idempotency-Key");
        node.DefaultRequestHeaders.Add("Idempotency-Key", "approval-request-id-scope-approval-one");
        var firstApprovalRequest = new DeviceApprovalRequest(
            firstClaim!.Execution!.Id,
            ApprovalKindValue.FileWrite,
            "write first file",
            "{\"path\":\"first.txt\"}",
            RequestId: "0");
        var firstApprovalResponse = await node.PostAsJsonAsync(
            $"/api/v1/device-tasks/{firstTask.TaskId:D}/approvals",
            firstApprovalRequest,
            JsonOptions);
        Assert.Equal(HttpStatusCode.Created, firstApprovalResponse.StatusCode);
        var firstApproval = await firstApprovalResponse.Content.ReadFromJsonAsync<DeviceApprovalResponse>(JsonOptions);
        Assert.NotNull(firstApproval);

        node.DefaultRequestHeaders.Remove("Idempotency-Key");
        node.DefaultRequestHeaders.Add("Idempotency-Key", "approval-request-id-scope-approval-one");
        var sameExecutionReplay = await node.PostAsJsonAsync(
            $"/api/v1/device-tasks/{firstTask.TaskId:D}/approvals",
            firstApprovalRequest,
            JsonOptions);
        Assert.Equal(HttpStatusCode.OK, sameExecutionReplay.StatusCode);
        var replayedApproval = await sameExecutionReplay.Content.ReadFromJsonAsync<DeviceApprovalResponse>(JsonOptions);
        Assert.Equal(firstApproval!.ApprovalId, replayedApproval?.ApprovalId);

        node.DefaultRequestHeaders.Remove("Idempotency-Key");
        node.DefaultRequestHeaders.Add("Idempotency-Key", "approval-request-id-scope-approval-one");
        var sameExecutionConflict = await node.PostAsJsonAsync(
            $"/api/v1/device-tasks/{firstTask.TaskId:D}/approvals",
            firstApprovalRequest with { Reason = "write a different file" },
            JsonOptions);
        Assert.Equal(HttpStatusCode.Conflict, sameExecutionConflict.StatusCode);

        node.DefaultRequestHeaders.Remove("Idempotency-Key");
        node.DefaultRequestHeaders.Add("Idempotency-Key", "approval-request-id-scope-claim-two");
        var secondClaimResponse = await node.PostAsJsonAsync(
            "/api/v1/device-tasks/claim",
            new DeviceTaskClaimRequest(
                "approval-scope-owner",
                new CapabilityEnvelopeContract(ReadFiles: true, AllowedRoots: [Path.GetTempPath()])),
            JsonOptions);
        Assert.Equal(HttpStatusCode.OK, secondClaimResponse.StatusCode);
        var secondClaim = await secondClaimResponse.Content.ReadFromJsonAsync<DeviceTaskClaimResponse>(JsonOptions);
        Assert.True(secondClaim?.Claimed);
        Assert.Equal(secondTask.TaskId, secondClaim?.Task?.Id);
        Assert.NotNull(secondClaim?.Execution);

        node.DefaultRequestHeaders.Remove("Idempotency-Key");
        node.DefaultRequestHeaders.Add("Idempotency-Key", "approval-request-id-scope-approval-two");
        var secondApprovalResponse = await node.PostAsJsonAsync(
            $"/api/v1/device-tasks/{secondTask.TaskId:D}/approvals",
            new DeviceApprovalRequest(
                secondClaim!.Execution!.Id,
                ApprovalKindValue.FileWrite,
                "write second file",
                "{\"path\":\"second.txt\"}",
                RequestId: "0"),
            JsonOptions);
        Assert.Equal(HttpStatusCode.Created, secondApprovalResponse.StatusCode);
        var secondApproval = await secondApprovalResponse.Content.ReadFromJsonAsync<DeviceApprovalResponse>(JsonOptions);
        Assert.NotNull(secondApproval);
        Assert.NotEqual(firstApproval.ApprovalId, secondApproval!.ApprovalId);

        UseBearer(ui, factory.Token);
        ui.DefaultRequestHeaders.Remove("Idempotency-Key");
        ui.DefaultRequestHeaders.Add("Idempotency-Key", "approval-request-id-scope-decision-one");
        var firstDecisionResponse = await ui.PostAsJsonAsync(
            $"/api/v1/approvals/{firstApproval.ApprovalId:D}/decision",
            new ApprovalDecisionRequest(ApprovalDecisionValue.Approve, ApprovalScopeValue.Once, "ui-scope-one"),
            JsonOptions);
        Assert.Equal(HttpStatusCode.OK, firstDecisionResponse.StatusCode);
        var firstDecision = await firstDecisionResponse.Content.ReadFromJsonAsync<ApprovalResponse>(JsonOptions);
        Assert.Equal(ApprovalStatusValue.Approved, firstDecision?.Status);

        ui.DefaultRequestHeaders.Remove("Idempotency-Key");
        ui.DefaultRequestHeaders.Add("Idempotency-Key", "approval-request-id-scope-decision-two");
        var secondDecisionResponse = await ui.PostAsJsonAsync(
            $"/api/v1/approvals/{secondApproval.ApprovalId:D}/decision",
            new ApprovalDecisionRequest(ApprovalDecisionValue.Deny, ApprovalScopeValue.Once, "ui-scope-two"),
            JsonOptions);
        Assert.Equal(HttpStatusCode.OK, secondDecisionResponse.StatusCode);
        var secondDecision = await secondDecisionResponse.Content.ReadFromJsonAsync<ApprovalResponse>(JsonOptions);
        Assert.Equal(ApprovalStatusValue.Denied, secondDecision?.Status);
    }

    private static async System.Threading.Tasks.Task<TaskAcceptedResponse> CreateTaskAsync(HttpClient client, Guid conversationId, string goal)
    {
        client.DefaultRequestHeaders.Remove("Idempotency-Key");
        client.DefaultRequestHeaders.Add("Idempotency-Key", $"approval-request-id-scope-task-{Guid.NewGuid():N}");
        var response = await client.PostAsJsonAsync(
            "/api/v1/tasks",
            new CreateTaskRequest(
                conversationId,
                [],
                goal,
                null,
                ["localFiles"],
                CapabilityEnvelope: new CapabilityEnvelopeContract(ReadFiles: true, AllowedRoots: [Path.GetTempPath()])),
            JsonOptions);
        Assert.Equal(HttpStatusCode.Accepted, response.StatusCode);
        return (await response.Content.ReadFromJsonAsync<TaskAcceptedResponse>(JsonOptions))!;
    }

    private static void UseBearer(HttpClient client, string token) =>
        client.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", token);

    private static readonly JsonSerializerOptions JsonOptions = new(JsonSerializerDefaults.Web);
}
