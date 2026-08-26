using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Security.Cryptography;
using System.Text.Json;
using Jarvis.Contracts;
using Jarvis.Domain.Approvals;
using Jarvis.Domain.Notifications;
using Jarvis.Domain.Tasks;
using Jarvis.Infrastructure.Data;
using Jarvis.Infrastructure.Devices;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using DomainTaskStatus = Jarvis.Domain.Tasks.TaskStatus;
using Xunit;

namespace Jarvis.Api.IntegrationTests;

public sealed class Phase4ApiTests : IDisposable
{
    private readonly TestApplicationFactory factory = new();

    public void Dispose() => factory.Dispose();

    [Fact]
    public async System.Threading.Tasks.Task RegisteredDeviceCredentialIsRequiredForHeartbeatAndClaim()
    {
        using var client = factory.CreateClient();
        UseBearer(client, factory.Token);
        client.DefaultRequestHeaders.Add("Idempotency-Key", "phase4-register");
        var registration = await client.PostAsJsonAsync(
            "/api/v1/devices/register",
            new DeviceRegistrationRequest("Phase 4 Node", DeviceTypeValue.Desktop, "macos", ["readFiles", "writeFiles"]),
            JsonOptions);

        Assert.Equal(HttpStatusCode.Created, registration.StatusCode);
        var device = await registration.Content.ReadFromJsonAsync<DeviceRegistrationResponse>(JsonOptions);
        Assert.NotNull(device);
        Assert.NotEmpty(device!.DeviceCredential);
        await using (var scope = factory.Services.CreateAsyncScope())
        {
            var db = scope.ServiceProvider.GetRequiredService<JarvisDbContext>();
            Assert.DoesNotContain(
                await db.IdempotencyRecords.Select(item => item.ResponseJson).ToListAsync(),
                json => json.Contains(device.DeviceCredential, StringComparison.Ordinal));
            Assert.DoesNotContain(
                await db.Devices.Select(item => item.CredentialHash).ToListAsync(),
                value => string.Equals(value, device.DeviceCredential, StringComparison.Ordinal));
        }

        client.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", device.DeviceCredential);
        client.DefaultRequestHeaders.Remove("Idempotency-Key");
        client.DefaultRequestHeaders.Add("Idempotency-Key", "phase4-offline-claim");
        var offlineClaim = await client.PostAsJsonAsync(
            "/api/v1/device-tasks/claim",
            new DeviceTaskClaimRequest("phase4-test-node"),
            JsonOptions);
        Assert.Equal(HttpStatusCode.Forbidden, offlineClaim.StatusCode);

        client.DefaultRequestHeaders.Remove("Idempotency-Key");
        client.DefaultRequestHeaders.Add("Idempotency-Key", "phase4-heartbeat");
        var heartbeat = await client.PostAsJsonAsync(
            $"/api/v1/devices/{device.DeviceId}/heartbeat",
            new DeviceHeartbeatRequest(["readFiles", "writeFiles"]),
            JsonOptions);
        Assert.Equal(HttpStatusCode.OK, heartbeat.StatusCode);

        var claim = await client.PostAsJsonAsync(
            "/api/v1/device-tasks/claim",
            new DeviceTaskClaimRequest("phase4-test-node"),
            JsonOptions);
        Assert.Equal(HttpStatusCode.OK, claim.StatusCode);
    }

    [Fact]
    public async System.Threading.Tasks.Task UiCanPullPendingApprovalsAndASecondDecisionCannotChangeIt()
    {
        using var client = factory.CreateClient();
        UseBearer(client, factory.Token);
        client.DefaultRequestHeaders.Add("Idempotency-Key", "phase4-conversation");
        var conversationResponse = await client.PostAsJsonAsync(
            "/api/v1/conversations",
            new CreateConversationRequest("Phase 4 approval"),
            JsonOptions);
        Assert.Equal(HttpStatusCode.Created, conversationResponse.StatusCode);
        var conversation = await conversationResponse.Content.ReadFromJsonAsync<ConversationResponse>(JsonOptions);
        Assert.NotNull(conversation);

        client.DefaultRequestHeaders.Remove("Idempotency-Key");
        client.DefaultRequestHeaders.Add("Idempotency-Key", "phase4-task");
        var taskResponse = await client.PostAsJsonAsync(
            "/api/v1/tasks",
            new CreateTaskRequest(
                conversation!.Id,
                [],
                "write a report",
                "a report",
                ["localFiles"],
                CapabilityEnvelope: new CapabilityEnvelopeContract(ReadFiles: true, AllowedRoots: [Path.GetTempPath()])),
            JsonOptions);
        Assert.Equal(HttpStatusCode.Accepted, taskResponse.StatusCode);
        var accepted = await taskResponse.Content.ReadFromJsonAsync<TaskAcceptedResponse>(JsonOptions);
        Assert.NotNull(accepted);

        client.DefaultRequestHeaders.Remove("Idempotency-Key");
        client.DefaultRequestHeaders.Add("Idempotency-Key", "phase4-approval-device");
        var registration = await client.PostAsJsonAsync(
            "/api/v1/devices/register",
            new DeviceRegistrationRequest("Approval Node", DeviceTypeValue.Desktop, "macos", ["localFiles"], [Path.GetTempPath()]),
            JsonOptions);
        Assert.Equal(HttpStatusCode.Created, registration.StatusCode);
        var device = await registration.Content.ReadFromJsonAsync<DeviceRegistrationResponse>(JsonOptions);
        Assert.NotNull(device);

        client.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", device!.DeviceCredential);
        client.DefaultRequestHeaders.Remove("Idempotency-Key");
        client.DefaultRequestHeaders.Add("Idempotency-Key", "phase4-approval-heartbeat");
        Assert.Equal(HttpStatusCode.OK, (await client.PostAsJsonAsync(
            $"/api/v1/devices/{device.DeviceId}/heartbeat",
            new DeviceHeartbeatRequest(["localFiles"], [Path.GetTempPath()]),
            JsonOptions)).StatusCode);

        client.DefaultRequestHeaders.Remove("Idempotency-Key");
        client.DefaultRequestHeaders.Add("Idempotency-Key", "phase4-approval-claim");
        var claimResponse = await client.PostAsJsonAsync(
            "/api/v1/device-tasks/claim",
            new DeviceTaskClaimRequest(
                "approval-node-owner",
                new CapabilityEnvelopeContract(ReadFiles: true, AllowedRoots: [Path.GetTempPath()])),
            JsonOptions);
        Assert.Equal(HttpStatusCode.OK, claimResponse.StatusCode);
        var claim = await claimResponse.Content.ReadFromJsonAsync<DeviceTaskClaimResponse>(JsonOptions);
        Assert.NotNull(claim?.Execution);

        client.DefaultRequestHeaders.Add("X-Lease-Owner", "approval-node-owner");
        client.DefaultRequestHeaders.Remove("Idempotency-Key");
        client.DefaultRequestHeaders.Add("Idempotency-Key", "phase4-approval-request");
        var approvalResponse = await client.PostAsJsonAsync(
            $"/api/v1/device-tasks/{accepted!.TaskId}/approvals",
            new DeviceApprovalRequest(claim!.Execution!.Id, ApprovalKindValue.FileWrite, "write report", "{\"path\":\"/work/report.md\"}", RequestId: "rpc-7"),
            JsonOptions);
        Assert.Equal(HttpStatusCode.Created, approvalResponse.StatusCode);
        var createdApproval = await approvalResponse.Content.ReadFromJsonAsync<DeviceApprovalResponse>(JsonOptions);
        Assert.NotNull(createdApproval);

        UseBearer(client, factory.Token);
        client.DefaultRequestHeaders.Remove("X-Lease-Owner");
        client.DefaultRequestHeaders.Remove("Idempotency-Key");
        var pendingResponse = await client.GetAsync("/api/v1/approvals?status=pending");
        Assert.Equal(HttpStatusCode.OK, pendingResponse.StatusCode);
        var pendingJson = await pendingResponse.Content.ReadAsStringAsync();
        Assert.DoesNotContain("requestedActionJson", pendingJson, StringComparison.Ordinal);
        var approvals = JsonSerializer.Deserialize<ApprovalListResponse>(pendingJson, JsonOptions);
        var pending = Assert.Single(approvals!.Items, item => item.Id == createdApproval!.ApprovalId);
        Assert.Equal(ApprovalStatusValue.Pending, pending.Status);

        client.DefaultRequestHeaders.Add("Idempotency-Key", "phase4-approval-decision");
        var decisionRequest = new ApprovalDecisionRequest(ApprovalDecisionValue.Approve, ApprovalScopeValue.Once, "ui-approval-1");
        var decisionResponse = await client.PostAsJsonAsync($"/api/v1/approvals/{pending.Id}/decision", decisionRequest, JsonOptions);
        Assert.Equal(HttpStatusCode.OK, decisionResponse.StatusCode);
        var decided = await decisionResponse.Content.ReadFromJsonAsync<ApprovalResponse>(JsonOptions);
        Assert.Equal(ApprovalStatusValue.Approved, decided!.Status);
        Assert.Equal(ApprovalScopeValue.Once, decided.Scope);

        var replay = await client.PostAsJsonAsync($"/api/v1/approvals/{pending.Id}/decision", decisionRequest, JsonOptions);
        Assert.Equal(HttpStatusCode.OK, replay.StatusCode);
        client.DefaultRequestHeaders.Remove("Idempotency-Key");
        client.DefaultRequestHeaders.Add("Idempotency-Key", "phase4-approval-different-decision");
        var conflicting = await client.PostAsJsonAsync($"/api/v1/approvals/{pending.Id}/decision", decisionRequest with { Decision = ApprovalDecisionValue.Deny, ClientRequestId = "ui-approval-2" }, JsonOptions);
        Assert.Equal(HttpStatusCode.Conflict, conflicting.StatusCode);

        await using var scope = factory.Services.CreateAsyncScope();
        var db = scope.ServiceProvider.GetRequiredService<JarvisDbContext>();
        Assert.Equal(DomainTaskStatus.Running, await db.Tasks.Where(item => item.Id == accepted.TaskId).Select(item => item.Status).SingleAsync());
        Assert.Equal(TaskExecutionStatus.Running, await db.TaskExecutions.Where(item => item.Id == claim.Execution!.Id).Select(item => item.Status).SingleAsync());
        Assert.Contains(await db.TaskEvents.Where(item => item.TaskId == accepted.TaskId).Select(item => item.EventType).ToListAsync(), item => item == "approval.approved");
        Assert.Contains(await db.Notifications.Where(item => item.ApprovalId == pending.Id).Select(item => item.Status).ToListAsync(), item => item == NotificationStatus.Actioned);
        Assert.Contains(await db.OutboxMessages.Select(item => item.EventType).ToListAsync(), item => item == "approval.resolved");
    }

    [Fact]
    public async System.Threading.Tasks.Task UiDenialSafelyFailsTheTaskAndReturnsTheBoundDecisionToTheDevice()
    {
        using var ui = factory.CreateClient();
        UseBearer(ui, factory.Token);
        ui.DefaultRequestHeaders.Add("Idempotency-Key", $"deny-conversation-{Guid.NewGuid():N}");
        var conversation = await (await ui.PostAsJsonAsync(
            "/api/v1/conversations",
            new CreateConversationRequest("Denied approval"),
            JsonOptions)).Content.ReadFromJsonAsync<ConversationResponse>(JsonOptions);
        ui.DefaultRequestHeaders.Remove("Idempotency-Key");
        ui.DefaultRequestHeaders.Add("Idempotency-Key", $"deny-task-{Guid.NewGuid():N}");
        var accepted = await (await ui.PostAsJsonAsync(
            "/api/v1/tasks",
            new CreateTaskRequest(
                conversation!.Id,
                [],
                "write denied file",
                null,
                ["localFiles"],
                CapabilityEnvelope: new CapabilityEnvelopeContract(ReadFiles: true, AllowedRoots: [Path.GetTempPath()])),
            JsonOptions)).Content.ReadFromJsonAsync<TaskAcceptedResponse>(JsonOptions);
        ui.DefaultRequestHeaders.Remove("Idempotency-Key");
        ui.DefaultRequestHeaders.Add("Idempotency-Key", $"deny-device-{Guid.NewGuid():N}");
        var device = await (await ui.PostAsJsonAsync(
            "/api/v1/devices/register",
            new DeviceRegistrationRequest("Deny Node", DeviceTypeValue.Desktop, "macos", ["localFiles"], [Path.GetTempPath()]),
            JsonOptions)).Content.ReadFromJsonAsync<DeviceRegistrationResponse>(JsonOptions);

        using var node = factory.CreateClient();
        UseBearer(node, device!.DeviceCredential);
        node.DefaultRequestHeaders.Add("Idempotency-Key", $"deny-heartbeat-{Guid.NewGuid():N}");
        (await node.PostAsJsonAsync(
            $"/api/v1/devices/{device.DeviceId:D}/heartbeat",
            new DeviceHeartbeatRequest(["localFiles"], [Path.GetTempPath()]),
            JsonOptions)).EnsureSuccessStatusCode();
        node.DefaultRequestHeaders.Remove("Idempotency-Key");
        node.DefaultRequestHeaders.Add("Idempotency-Key", $"deny-claim-{Guid.NewGuid():N}");
        var claim = await (await node.PostAsJsonAsync(
            "/api/v1/device-tasks/claim",
            new DeviceTaskClaimRequest(
                "deny-owner",
                new CapabilityEnvelopeContract(ReadFiles: true, AllowedRoots: [Path.GetTempPath()])),
            JsonOptions)).Content.ReadFromJsonAsync<DeviceTaskClaimResponse>(JsonOptions);
        Assert.True(claim!.Claimed);
        node.DefaultRequestHeaders.Add("X-Lease-Owner", "deny-owner");
        node.DefaultRequestHeaders.Remove("Idempotency-Key");
        node.DefaultRequestHeaders.Add("Idempotency-Key", $"deny-approval-{Guid.NewGuid():N}");
        var approval = await (await node.PostAsJsonAsync(
            $"/api/v1/device-tasks/{accepted!.TaskId:D}/approvals",
            new DeviceApprovalRequest(
                claim.Execution!.Id,
                ApprovalKindValue.FileWrite,
                "write denied file",
                "{\"path\":\"denied.txt\"}",
                RequestId: "deny-request"),
            JsonOptions)).Content.ReadFromJsonAsync<DeviceApprovalResponse>(JsonOptions);

        ui.DefaultRequestHeaders.Remove("Idempotency-Key");
        ui.DefaultRequestHeaders.Add("Idempotency-Key", $"deny-decision-{Guid.NewGuid():N}");
        var decision = await ui.PostAsJsonAsync(
            $"/api/v1/approvals/{approval!.ApprovalId:D}/decision",
            new ApprovalDecisionRequest(ApprovalDecisionValue.Deny, ApprovalScopeValue.Once, "desktop-deny"),
            JsonOptions);
        decision.EnsureSuccessStatusCode();
        var denied = await decision.Content.ReadFromJsonAsync<ApprovalResponse>(JsonOptions);
        Assert.Equal(ApprovalStatusValue.Denied, denied!.Status);

        var deviceStatus = await (await node.GetAsync(
            $"/api/v1/device-tasks/{accepted.TaskId:D}/approvals/{approval.ApprovalId:D}"))
            .Content.ReadFromJsonAsync<DeviceApprovalStatusResponse>(JsonOptions);
        Assert.Equal(ApprovalDecisionValue.Deny, deviceStatus!.Decision);
        Assert.Equal(ApprovalScopeValue.Once, deviceStatus.Scope);

        await using var scope = factory.Services.CreateAsyncScope();
        var db = scope.ServiceProvider.GetRequiredService<JarvisDbContext>();
        Assert.Equal(DomainTaskStatus.Failed, await db.Tasks
            .Where(item => item.Id == accepted.TaskId)
            .Select(item => item.Status)
            .SingleAsync());
        Assert.Equal(TaskExecutionStatus.Failed, await db.TaskExecutions
            .Where(item => item.Id == claim.Execution.Id)
            .Select(item => item.Status)
            .SingleAsync());
        Assert.Contains(await db.Notifications
            .Where(item => item.TaskId == accepted.TaskId)
            .Select(item => item.Type)
            .ToListAsync(), type => type == "task.failed");
    }

    [Fact]
    public async System.Threading.Tasks.Task TwoDeviceCredentialsCompetingForOneCodexTaskHaveOneAtomicWinner()
    {
        using var ui = factory.CreateClient();
        UseBearer(ui, factory.Token);
        ui.DefaultRequestHeaders.Add("Idempotency-Key", $"phase4-conversation-{Guid.NewGuid():N}");
        var conversation = await (await ui.PostAsJsonAsync(
            "/api/v1/conversations",
            new CreateConversationRequest("Phase 4 claim race"),
            JsonOptions)).Content.ReadFromJsonAsync<ConversationResponse>(JsonOptions);
        Assert.NotNull(conversation);
        ui.DefaultRequestHeaders.Remove("Idempotency-Key");
        ui.DefaultRequestHeaders.Add("Idempotency-Key", $"phase4-task-{Guid.NewGuid():N}");
        var accepted = await (await ui.PostAsJsonAsync(
            "/api/v1/tasks",
            new CreateTaskRequest(
                conversation!.Id,
                [],
                "claim once",
                null,
                ["localFiles"],
                CapabilityEnvelope: new CapabilityEnvelopeContract(ReadFiles: true, AllowedRoots: [Path.GetTempPath()])),
            JsonOptions)).Content.ReadFromJsonAsync<TaskAcceptedResponse>(JsonOptions);
        Assert.NotNull(accepted);

        var first = await RegisterDeviceAsync("race-one");
        var second = await RegisterDeviceAsync("race-two");
        await HeartbeatAsync(first);
        await HeartbeatAsync(second);

        using var firstClient = factory.CreateClient();
        using var secondClient = factory.CreateClient();
        UseBearer(firstClient, first.DeviceCredential);
        UseBearer(secondClient, second.DeviceCredential);
        firstClient.DefaultRequestHeaders.Add("Idempotency-Key", $"claim-one-{Guid.NewGuid():N}");
        secondClient.DefaultRequestHeaders.Add("Idempotency-Key", $"claim-two-{Guid.NewGuid():N}");
        var claimRequest = new DeviceTaskClaimRequest(
            "race-node",
            new CapabilityEnvelopeContract(ReadFiles: true, AllowedRoots: [Path.GetTempPath()]));
        var claims = await System.Threading.Tasks.Task.WhenAll(
            firstClient.PostAsJsonAsync("/api/v1/device-tasks/claim", claimRequest with { LeaseOwner = "race-one" }, JsonOptions),
            secondClient.PostAsJsonAsync("/api/v1/device-tasks/claim", claimRequest with { LeaseOwner = "race-two" }, JsonOptions));
        var statuses = claims.Select(response => response.StatusCode).ToArray();
        Assert.All(statuses, status => Assert.True(status is HttpStatusCode.OK or HttpStatusCode.Conflict));
        var claimed = new List<DeviceTaskClaimResponse>();
        foreach (var response in claims.Where(response => response.StatusCode == HttpStatusCode.OK))
        {
            var value = await response.Content.ReadFromJsonAsync<DeviceTaskClaimResponse>(JsonOptions);
            if (value is not null)
            {
                claimed.Add(value);
            }
        }

        Assert.Single(claimed, item => item.Claimed);
        await using (var dbScope = factory.Services.CreateAsyncScope())
        {
            Assert.Equal(1, await dbScope.ServiceProvider
                .GetRequiredService<JarvisDbContext>().TaskExecutions
                .CountAsync(item => item.TaskId == accepted!.TaskId));
        }

        async System.Threading.Tasks.Task<DeviceRegistrationResponse> RegisterDeviceAsync(string name)
        {
            using var registrationClient = factory.CreateClient();
            UseBearer(registrationClient, factory.Token);
            registrationClient.DefaultRequestHeaders.Add("Idempotency-Key", $"register-{name}-{Guid.NewGuid():N}");
            var response = await registrationClient.PostAsJsonAsync(
                "/api/v1/devices/register",
                new DeviceRegistrationRequest(name, DeviceTypeValue.Desktop, "macos", ["localFiles"], [Path.GetTempPath()]),
                JsonOptions);
            response.EnsureSuccessStatusCode();
            return (await response.Content.ReadFromJsonAsync<DeviceRegistrationResponse>(JsonOptions))!;
        }

        async System.Threading.Tasks.Task HeartbeatAsync(DeviceRegistrationResponse device)
        {
            using var heartbeatClient = factory.CreateClient();
            UseBearer(heartbeatClient, device.DeviceCredential);
            heartbeatClient.DefaultRequestHeaders.Add("Idempotency-Key", $"heartbeat-{device.DeviceId:D}-{Guid.NewGuid():N}");
            var response = await heartbeatClient.PostAsJsonAsync(
                $"/api/v1/devices/{device.DeviceId}/heartbeat",
                new DeviceHeartbeatRequest(["localFiles"], [Path.GetTempPath()]),
                JsonOptions);
            response.EnsureSuccessStatusCode();
        }
    }

    [Fact]
    public async System.Threading.Tasks.Task UiAndDeviceCredentialsCannotCrossTheirBoundaries()
    {
        using var ui = factory.CreateClient();
        UseBearer(ui, factory.Token);
        var deviceRoute = await ui.PostAsJsonAsync(
            "/api/v1/device-tasks/claim",
            new DeviceTaskClaimRequest("wrong-ui"),
            JsonOptions);
        Assert.Equal(HttpStatusCode.Unauthorized, deviceRoute.StatusCode);

        ui.DefaultRequestHeaders.Add("Idempotency-Key", $"register-boundary-{Guid.NewGuid():N}");
        var registration = await ui.PostAsJsonAsync(
            "/api/v1/devices/register",
            new DeviceRegistrationRequest("Boundary Node", DeviceTypeValue.Desktop, "macos", []),
            JsonOptions);
        var device = (await registration.Content.ReadFromJsonAsync<DeviceRegistrationResponse>(JsonOptions))!;
        using var deviceClient = factory.CreateClient();
        UseBearer(deviceClient, device.DeviceCredential);
        Assert.Equal(HttpStatusCode.Unauthorized, (await deviceClient.GetAsync("/api/v1/approvals?status=pending")).StatusCode);
    }

    [Fact]
    public async System.Threading.Tasks.Task ClaimCapabilityEnvelopeIsIntersectedWithTheUserRegisteredRoots()
    {
        var parent = Directory.CreateTempSubdirectory("jarvis-phase4-claim-roots-");
        var outside = Directory.CreateTempSubdirectory("jarvis-phase4-outside-root-");
        try
        {
            var allowed = Directory.CreateDirectory(Path.Combine(parent.FullName, "allowed")).FullName;
            using var ui = factory.CreateClient();
            UseBearer(ui, factory.Token);
            ui.DefaultRequestHeaders.Add("Idempotency-Key", $"roots-conversation-{Guid.NewGuid():N}");
            var conversation = await (await ui.PostAsJsonAsync(
                "/api/v1/conversations",
                new CreateConversationRequest("Phase 4 root intersection"),
                JsonOptions)).Content.ReadFromJsonAsync<ConversationResponse>(JsonOptions);
            Assert.NotNull(conversation);
            ui.DefaultRequestHeaders.Remove("Idempotency-Key");
            ui.DefaultRequestHeaders.Add("Idempotency-Key", $"roots-task-missing-envelope-{Guid.NewGuid():N}");
            var missingEnvelope = await ui.PostAsJsonAsync(
                "/api/v1/tasks",
                new CreateTaskRequest(conversation!.Id, [], "unsafe implicit root", null, ["localFiles"]),
                JsonOptions);
            Assert.Equal(HttpStatusCode.BadRequest, missingEnvelope.StatusCode);

            ui.DefaultRequestHeaders.Remove("Idempotency-Key");
            ui.DefaultRequestHeaders.Add("Idempotency-Key", $"roots-task-{Guid.NewGuid():N}");
            var accepted = await (await ui.PostAsJsonAsync(
                "/api/v1/tasks",
                new CreateTaskRequest(
                    conversation!.Id,
                    [],
                    "read the allowed report",
                    null,
                    ["localFiles"],
                    CapabilityEnvelope: new CapabilityEnvelopeContract(ReadFiles: true, AllowedRoots: [allowed])),
                JsonOptions)).Content.ReadFromJsonAsync<TaskAcceptedResponse>(JsonOptions);
            Assert.NotNull(accepted);

            ui.DefaultRequestHeaders.Remove("Idempotency-Key");
            ui.DefaultRequestHeaders.Add("Idempotency-Key", $"roots-device-{Guid.NewGuid():N}");
            var registration = await ui.PostAsJsonAsync(
                "/api/v1/devices/register",
                new DeviceRegistrationRequest("Root Boundary Node", DeviceTypeValue.Desktop, "macos", ["localFiles", "writeFiles", "runCommands", "network"], [parent.FullName]),
                JsonOptions);
            registration.EnsureSuccessStatusCode();
            var device = (await registration.Content.ReadFromJsonAsync<DeviceRegistrationResponse>(JsonOptions))!;
            using var node = factory.CreateClient();
            UseBearer(node, device.DeviceCredential);
            node.DefaultRequestHeaders.Add("Idempotency-Key", $"roots-heartbeat-{Guid.NewGuid():N}");
            (await node.PostAsJsonAsync(
                $"/api/v1/devices/{device.DeviceId}/heartbeat",
                new DeviceHeartbeatRequest(["localFiles", "writeFiles", "runCommands", "network"], [parent.FullName]),
                JsonOptions)).EnsureSuccessStatusCode();

            node.DefaultRequestHeaders.Remove("Idempotency-Key");
            node.DefaultRequestHeaders.Add("Idempotency-Key", $"roots-outside-{Guid.NewGuid():N}");
            var outsideClaim = await (await node.PostAsJsonAsync(
                "/api/v1/device-tasks/claim",
                new DeviceTaskClaimRequest("root-node", new CapabilityEnvelopeContract(ReadFiles: true, AllowedRoots: [outside.FullName])),
                JsonOptions)).Content.ReadFromJsonAsync<DeviceTaskClaimResponse>(JsonOptions);
            Assert.NotNull(outsideClaim);
            Assert.False(outsideClaim!.Claimed);

            node.DefaultRequestHeaders.Remove("Idempotency-Key");
            node.DefaultRequestHeaders.Add("Idempotency-Key", $"roots-allowed-{Guid.NewGuid():N}");
            var allowedClaim = await (await node.PostAsJsonAsync(
                "/api/v1/device-tasks/claim",
                new DeviceTaskClaimRequest(
                    "root-node",
                    new CapabilityEnvelopeContract(
                        ReadFiles: true,
                        WriteFiles: true,
                        RunCommands: true,
                        Network: true,
                        AllowedRoots: [parent.FullName])),
                JsonOptions)).Content.ReadFromJsonAsync<DeviceTaskClaimResponse>(JsonOptions);
            Assert.NotNull(allowedClaim);
            Assert.True(allowedClaim!.Claimed);
            Assert.Equal([allowed], allowedClaim.CapabilityEnvelope!.AllowedRoots);
            Assert.False(allowedClaim.CapabilityEnvelope.WriteFiles);
            Assert.False(allowedClaim.CapabilityEnvelope.RunCommands);
            Assert.False(allowedClaim.CapabilityEnvelope.Network);
            Assert.Equal(accepted!.TaskId, allowedClaim.Task!.Id);
            using var executionMetadata = JsonDocument.Parse(allowedClaim.Execution!.MetadataJson);
            Assert.Equal(
                [allowed],
                executionMetadata.RootElement.GetProperty("allowedRoots")
                    .EnumerateArray()
                    .Select(item => item.GetString()));

            var siblingArtifactPath = Path.Combine(parent.FullName, "sibling.txt");
            await File.WriteAllTextAsync(siblingArtifactPath, "outside effective envelope");
            var siblingBytes = await File.ReadAllBytesAsync(siblingArtifactPath);
            node.DefaultRequestHeaders.Add("X-Lease-Owner", "root-node");
            node.DefaultRequestHeaders.Remove("Idempotency-Key");
            node.DefaultRequestHeaders.Add("Idempotency-Key", $"roots-premature-turn-{Guid.NewGuid():N}");
            var prematureTurn = await node.PostAsJsonAsync(
                $"/api/v1/device-tasks/{accepted.TaskId:D}/events",
                new DeviceTaskEventRequest(
                    $"premature-turn-{Guid.NewGuid():N}",
                    allowedClaim.Execution.Id,
                    "codex.turn.started",
                    CodexThreadId: "thread-bounded",
                    CodexTurnId: "turn-bounded"),
                JsonOptions);
            Assert.Equal(HttpStatusCode.BadRequest, prematureTurn.StatusCode);

            node.DefaultRequestHeaders.Remove("Idempotency-Key");
            node.DefaultRequestHeaders.Add("Idempotency-Key", $"roots-turn-starting-{Guid.NewGuid():N}");
            (await node.PostAsJsonAsync(
                $"/api/v1/device-tasks/{accepted.TaskId:D}/events",
                new DeviceTaskEventRequest(
                    $"turn-starting-{Guid.NewGuid():N}",
                    allowedClaim.Execution.Id,
                    "codex.turn.starting",
                    CodexThreadId: "thread-bounded"),
                JsonOptions)).EnsureSuccessStatusCode();

            node.DefaultRequestHeaders.Remove("Idempotency-Key");
            node.DefaultRequestHeaders.Add("Idempotency-Key", $"roots-turn-started-{Guid.NewGuid():N}");
            (await node.PostAsJsonAsync(
                $"/api/v1/device-tasks/{accepted.TaskId:D}/events",
                new DeviceTaskEventRequest(
                    $"turn-started-{Guid.NewGuid():N}",
                    allowedClaim.Execution.Id,
                    "codex.turn.started",
                    CodexThreadId: "thread-bounded",
                    CodexTurnId: "turn-bounded"),
                JsonOptions)).EnsureSuccessStatusCode();

            node.DefaultRequestHeaders.Remove("Idempotency-Key");
            node.DefaultRequestHeaders.Add("Idempotency-Key", $"roots-forged-event-{Guid.NewGuid():N}");
            var forgedCompletion = await node.PostAsJsonAsync(
                $"/api/v1/device-tasks/{accepted.TaskId:D}/events",
                new DeviceTaskEventRequest(
                    $"forged-completion-{Guid.NewGuid():N}",
                    allowedClaim.Execution.Id,
                    "device.claimed-success",
                    ResultSummary: "forged"),
                JsonOptions);
            Assert.Equal(HttpStatusCode.BadRequest, forgedCompletion.StatusCode);

            node.DefaultRequestHeaders.Remove("Idempotency-Key");
            node.DefaultRequestHeaders.Add("Idempotency-Key", $"roots-invalid-artifact-{Guid.NewGuid():N}");
            var invalidArtifact = await node.PostAsJsonAsync(
                $"/api/v1/device-tasks/{accepted.TaskId:D}/events",
                new DeviceTaskEventRequest(
                    $"invalid-artifact-{Guid.NewGuid():N}",
                    allowedClaim.Execution.Id,
                    "task.completed",
                    ResultSummary: "invalid",
                    Artifacts:
                    [
                        new ArtifactManifestEntry(
                            siblingArtifactPath,
                            siblingBytes.LongLength,
                            Convert.ToHexString(SHA256.HashData(siblingBytes)),
                            "text/plain")
                    ]),
                JsonOptions);
            Assert.Equal(HttpStatusCode.BadRequest, invalidArtifact.StatusCode);

            var artifactPath = Path.Combine(allowed, "result.txt");
            await File.WriteAllTextAsync(artifactPath, "bounded result");
            var artifactBytes = await File.ReadAllBytesAsync(artifactPath);
            var artifactHash = Convert.ToHexString(SHA256.HashData(artifactBytes));
            node.DefaultRequestHeaders.Remove("Idempotency-Key");
            node.DefaultRequestHeaders.Add("Idempotency-Key", $"roots-valid-artifact-{Guid.NewGuid():N}");
            var completed = await node.PostAsJsonAsync(
                $"/api/v1/device-tasks/{accepted.TaskId:D}/events",
                new DeviceTaskEventRequest(
                    $"valid-artifact-{Guid.NewGuid():N}",
                    allowedClaim.Execution.Id,
                    "task.completed",
                    ResultSummary: "bounded result",
                    Artifacts:
                    [
                        new ArtifactManifestEntry(
                            artifactPath,
                            artifactBytes.LongLength,
                            artifactHash,
                            "text/plain")
                    ]),
                JsonOptions);
            completed.EnsureSuccessStatusCode();

            var persisted = await ui.GetFromJsonAsync<TaskResponse>($"/api/v1/tasks/{accepted.TaskId:D}", JsonOptions);
            var artifact = Assert.Single(persisted!.Artifacts!);
            Assert.Equal(artifactPath, artifact.Path);
            Assert.Equal(artifactHash, artifact.Sha256);
            Assert.Equal("thread-bounded", persisted.Execution!.CodexThreadId);
            Assert.Equal("turn-bounded", persisted.Execution.CodexTurnId);
            Assert.NotNull(persisted.Execution.CodexTurnStartRequestedAtMs);
        }
        finally
        {
            parent.Delete(recursive: true);
            outside.Delete(recursive: true);
        }
    }

    [Fact]
    public async System.Threading.Tasks.Task ExpiredCodexLeaseIsDurablyMovedToRecovering()
    {
        var clock = new AdvancingTimeProvider(new DateTimeOffset(2026, 8, 26, 12, 0, 0, TimeSpan.Zero));
        await using var isolated = new TestApplicationFactory(
            databasePath: null,
            deleteDatabaseOnDispose: true,
            outboxPublisher: null,
            timeProvider: clock);
        using var ui = isolated.CreateClient();
        UseBearer(ui, isolated.Token);
        ui.DefaultRequestHeaders.Add("Idempotency-Key", $"recovery-conversation-{Guid.NewGuid():N}");
        var conversation = await (await ui.PostAsJsonAsync(
            "/api/v1/conversations",
            new CreateConversationRequest("Lease recovery"),
            JsonOptions)).Content.ReadFromJsonAsync<ConversationResponse>(JsonOptions);
        ui.DefaultRequestHeaders.Remove("Idempotency-Key");
        ui.DefaultRequestHeaders.Add("Idempotency-Key", $"recovery-task-{Guid.NewGuid():N}");
        var accepted = await (await ui.PostAsJsonAsync(
            "/api/v1/tasks",
            new CreateTaskRequest(
                conversation!.Id,
                [],
                "recover after device loss",
                null,
                ["localFiles"],
                CapabilityEnvelope: new CapabilityEnvelopeContract(ReadFiles: true, AllowedRoots: [Path.GetTempPath()])),
            JsonOptions)).Content.ReadFromJsonAsync<TaskAcceptedResponse>(JsonOptions);
        ui.DefaultRequestHeaders.Remove("Idempotency-Key");
        ui.DefaultRequestHeaders.Add("Idempotency-Key", $"recovery-device-{Guid.NewGuid():N}");
        var device = await (await ui.PostAsJsonAsync(
            "/api/v1/devices/register",
            new DeviceRegistrationRequest("Recovery Node", DeviceTypeValue.Desktop, "macos", ["localFiles"], [Path.GetTempPath()]),
            JsonOptions)).Content.ReadFromJsonAsync<DeviceRegistrationResponse>(JsonOptions);

        using var node = isolated.CreateClient();
        UseBearer(node, device!.DeviceCredential);
        node.DefaultRequestHeaders.Add("Idempotency-Key", $"recovery-heartbeat-{Guid.NewGuid():N}");
        (await node.PostAsJsonAsync(
            $"/api/v1/devices/{device.DeviceId:D}/heartbeat",
            new DeviceHeartbeatRequest(["localFiles"], [Path.GetTempPath()]),
            JsonOptions)).EnsureSuccessStatusCode();
        node.DefaultRequestHeaders.Remove("Idempotency-Key");
        node.DefaultRequestHeaders.Add("Idempotency-Key", $"recovery-claim-{Guid.NewGuid():N}");
        var claim = await (await node.PostAsJsonAsync(
            "/api/v1/device-tasks/claim",
            new DeviceTaskClaimRequest(
                "recovery-owner",
                new CapabilityEnvelopeContract(ReadFiles: true, AllowedRoots: [Path.GetTempPath()])),
            JsonOptions)).Content.ReadFromJsonAsync<DeviceTaskClaimResponse>(JsonOptions);
        Assert.True(claim!.Claimed);

        var active = await node.GetFromJsonAsync<DeviceActiveTaskListResponse>(
            "/api/v1/device-tasks/active",
            JsonOptions);
        var recoveredClaim = Assert.Single(active!.Items);
        Assert.Equal(accepted!.TaskId, recoveredClaim.Task!.Id);
        Assert.Equal(claim.Execution!.Id, recoveredClaim.Execution!.Id);
        Assert.Equal(claim.LeaseOwner, recoveredClaim.LeaseOwner);

        node.DefaultRequestHeaders.Add("X-Lease-Owner", "recovery-owner");
        node.DefaultRequestHeaders.Remove("Idempotency-Key");
        node.DefaultRequestHeaders.Add("Idempotency-Key", $"recovery-approval-{Guid.NewGuid():N}");
        var approval = await (await node.PostAsJsonAsync(
            $"/api/v1/device-tasks/{accepted!.TaskId:D}/approvals",
            new DeviceApprovalRequest(
                claim.Execution!.Id,
                ApprovalKindValue.Command,
                "run the bounded command",
                "{\"command\":\"pwd\"}",
                RequestId: "recovery-request"),
            JsonOptions)).Content.ReadFromJsonAsync<DeviceApprovalResponse>(JsonOptions);
        Assert.NotNull(approval);
        node.DefaultRequestHeaders.Remove("Idempotency-Key");
        node.DefaultRequestHeaders.Add("Idempotency-Key", $"recovery-renew-{Guid.NewGuid():N}");
        var renewal = await node.PostAsJsonAsync(
            $"/api/v1/device-tasks/{accepted.TaskId:D}/lease:renew",
            new DeviceTaskLeaseRenewRequest("recovery-owner"),
            JsonOptions);
        renewal.EnsureSuccessStatusCode();

        clock.Advance(TimeSpan.FromSeconds(31));
        await using var scope = isolated.Services.CreateAsyncScope();
        var recovered = await scope.ServiceProvider
            .GetRequiredService<DeviceLeaseRecoveryService>()
            .RecoverExpiredAsync();
        Assert.Equal(1, recovered);
        var db = scope.ServiceProvider.GetRequiredService<JarvisDbContext>();
        Assert.Equal(DomainTaskStatus.Recovering, await db.Tasks
            .Where(item => item.Id == accepted!.TaskId)
            .Select(item => item.Status)
            .SingleAsync());
        Assert.Equal(TaskExecutionStatus.Recovering, await db.TaskExecutions
            .Where(item => item.Id == claim.Execution!.Id)
            .Select(item => item.Status)
            .SingleAsync());
        Assert.Equal(ApprovalStatus.Cancelled, await db.Approvals
            .Where(item => item.Id == approval!.ApprovalId)
            .Select(item => item.Status)
            .SingleAsync());
        Assert.Contains(await db.Notifications
            .Where(item => item.TaskId == accepted!.TaskId)
            .Select(item => item.Type)
            .ToListAsync(), type => type == "task.recovering");
    }

    [Fact]
    public async System.Threading.Tasks.Task ApprovalExpiryMaintenanceFailsTheBoundExecutionAndResolvesThePrompt()
    {
        var clock = new AdvancingTimeProvider(new DateTimeOffset(2026, 8, 26, 13, 0, 0, TimeSpan.Zero));
        await using var isolated = new TestApplicationFactory(
            databasePath: null,
            deleteDatabaseOnDispose: true,
            outboxPublisher: null,
            timeProvider: clock);
        using var client = isolated.CreateClient();
        await using (var setupScope = isolated.Services.CreateAsyncScope())
        {
            var db = setupScope.ServiceProvider.GetRequiredService<JarvisDbContext>();
            var nowMs = clock.GetUtcNow().ToUnixTimeMilliseconds();
            var userId = await db.Users.Select(item => item.Id).SingleAsync();
            var deviceId = await db.Devices.Select(item => item.Id).FirstAsync();
            var conversation = Jarvis.Domain.Conversations.Conversation.Create(
                Guid.CreateVersion7(),
                userId,
                "Approval expiry",
                nowMs);
            var task = Jarvis.Domain.Tasks.Task.Create(
                Guid.CreateVersion7(),
                userId,
                conversation.Id,
                "wait for an expiring approval",
                null,
                "[\"localFiles\"]",
                "[]",
                deviceId,
                WorkerKind.Codex,
                0,
                nowMs);
            task.Assign("expiry-owner", nowMs + 30_000, nowMs, deviceId);
            task.Start(nowMs);
            task.WaitForApproval(nowMs);
            var execution = TaskExecution.Create(
                Guid.CreateVersion7(),
                task.Id,
                deviceId,
                WorkerKind.Codex,
                nowMs);
            execution.Start(nowMs);
            execution.WaitForApproval(nowMs);
            var approval = Approval.Create(
                Guid.CreateVersion7(),
                task.Id,
                execution.Id,
                deviceId,
                "expiry-request",
                ApprovalKind.Command,
                "run command",
                "{\"command\":\"pwd\"}",
                null,
                nowMs,
                nowMs + 1_000);
            var notification = Notification.Create(
                Guid.CreateVersion7(),
                userId,
                conversation.Id,
                task.Id,
                "approval.required",
                NotificationSeverity.Warning,
                "Approval required",
                "run command",
                $"approval:{approval.Id:D}",
                nowMs,
                approval.Id);
            db.AddRange(conversation, task, execution, approval, notification);
            await db.SaveChangesAsync();
        }

        clock.Advance(TimeSpan.FromMilliseconds(1_001));
        await using var scope = isolated.Services.CreateAsyncScope();
        var recovered = await scope.ServiceProvider
            .GetRequiredService<DeviceLeaseRecoveryService>()
            .RecoverExpiredAsync();
        Assert.Equal(0, recovered);
        var verification = scope.ServiceProvider.GetRequiredService<JarvisDbContext>();
        Assert.Equal(ApprovalStatus.Expired, await verification.Approvals.Select(item => item.Status).SingleAsync());
        Assert.Equal(DomainTaskStatus.Failed, await verification.Tasks.Select(item => item.Status).SingleAsync());
        Assert.Equal(TaskExecutionStatus.Failed, await verification.TaskExecutions.Select(item => item.Status).SingleAsync());
        Assert.Contains(await verification.OutboxMessages.Select(item => item.EventType).ToListAsync(), type => type == "approval.resolved");
        Assert.Contains(await verification.Notifications.Select(item => item.Status).ToListAsync(), status => status == NotificationStatus.Actioned);
    }

    private static void UseBearer(HttpClient client, string token)
    {
        client.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", token);
    }

    private static readonly JsonSerializerOptions JsonOptions = new(JsonSerializerDefaults.Web);

    private sealed class AdvancingTimeProvider(DateTimeOffset initial) : TimeProvider
    {
        private DateTimeOffset now = initial;

        public override DateTimeOffset GetUtcNow() => now;

        public void Advance(TimeSpan duration) => now += duration;
    }
}
