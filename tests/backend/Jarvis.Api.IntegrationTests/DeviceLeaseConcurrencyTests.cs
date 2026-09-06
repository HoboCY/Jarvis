using System.Data.Common;
using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Text.Json;
using Jarvis.Application.Devices;
using Jarvis.Contracts;
using Jarvis.Infrastructure.Data;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Diagnostics;
using Microsoft.Extensions.DependencyInjection;
using Xunit;

namespace Jarvis.Api.IntegrationTests;

public sealed class DeviceLeaseConcurrencyTests
{
    private static readonly JsonSerializerOptions JsonOptions = new(JsonSerializerDefaults.Web);

    [Fact]
    public async Task LeaseRenewalRetriesAfterTaskChangesBetweenReadAndWrite()
    {
        var gate = new LeaseTaskReadGate();
        var databasePath = Path.Combine(Path.GetTempPath(), $"jarvis-lease-race-{Guid.NewGuid():N}.db");
        using var factory = new TestApplicationFactory(databasePath, true, null, null, gate);
        var prepared = await PrepareRunningTaskAsync(factory);

        gate.Arm();
        using var renewClient = factory.CreateClient();
        ConfigureDeviceClient(renewClient, prepared.DeviceCredential, "lease-race-owner", "lease-race-renew");
        var renewTask = renewClient.PostAsJsonAsync(
            $"/api/v1/device-tasks/{prepared.TaskId:D}/lease:renew",
            new DeviceTaskLeaseRenewRequest("lease-race-owner"),
            JsonOptions);
        await gate.TaskReadReached.WaitAsync(TimeSpan.FromSeconds(5));

        using var mutationClient = factory.CreateClient();
        ConfigureDeviceClient(mutationClient, prepared.DeviceCredential, "lease-race-owner", "lease-race-progress");
        var mutationResponse = await mutationClient.PostAsJsonAsync(
            $"/api/v1/device-tasks/{prepared.TaskId:D}/events",
            new DeviceTaskEventRequest(
                "lease-race-progress-event",
                prepared.ExecutionId,
                "codex.progress",
                ProgressSummary: "still running"),
            JsonOptions);
        Assert.Equal(HttpStatusCode.OK, mutationResponse.StatusCode);

        gate.Release();
        using var renewResponse = await renewTask;
        Assert.Equal(HttpStatusCode.OK, renewResponse.StatusCode);
        var renewed = await renewResponse.Content.ReadFromJsonAsync<DeviceTaskLeaseRenewResponse>(JsonOptions);
        Assert.NotNull(renewed);
        Assert.True(renewed!.Renewed);

        await using var scope = factory.Services.CreateAsyncScope();
        var db = scope.ServiceProvider.GetRequiredService<JarvisDbContext>();
        Assert.Equal("still running", await db.Tasks
            .Where(item => item.Id == prepared.TaskId)
            .Select(item => item.ProgressSummary)
            .SingleAsync());
    }

    [Fact]
    public async Task LeaseRenewalReturnsConflictWhenConcurrencyBudgetIsExhausted()
    {
        var interceptor = new AlwaysRejectTaskUpdateInterceptor();
        var databasePath = Path.Combine(Path.GetTempPath(), $"jarvis-lease-exhausted-{Guid.NewGuid():N}.db");
        using var factory = new TestApplicationFactory(databasePath, true, null, null, interceptor);
        var prepared = await PrepareRunningTaskAsync(factory);
        interceptor.Arm();

        using var client = factory.CreateClient();
        ConfigureDeviceClient(client, prepared.DeviceCredential, "lease-race-owner", "lease-race-exhausted");
        using var response = await client.PostAsJsonAsync(
            $"/api/v1/device-tasks/{prepared.TaskId:D}/lease:renew",
            new DeviceTaskLeaseRenewRequest("lease-race-owner"),
            JsonOptions);

        Assert.Equal(HttpStatusCode.Conflict, response.StatusCode);
        Assert.True(interceptor.RejectionCount >= 3);
        await using var scope = factory.Services.CreateAsyncScope();
        var db = scope.ServiceProvider.GetRequiredService<JarvisDbContext>();
        var store = scope.ServiceProvider.GetRequiredService<IDeviceStore>();
        var directResult = await store.RenewLeaseAsync(
            prepared.DeviceId,
            prepared.TaskId,
            new DeviceTaskLeaseRenewRequest("lease-race-owner"),
            "lease-race-exhausted-direct",
            CancellationToken.None);
        Assert.Equal(Jarvis.Application.Devices.DeviceOperationStatus.Conflict, directResult.Status);
        Assert.NotNull(directResult.Value);
        Assert.False(directResult.Value!.Renewed);
        Assert.Equal(
            await db.Tasks.Where(item => item.Id == prepared.TaskId).Select(item => item.LeaseExpiresAtMs).SingleAsync(),
            directResult.Value.LeaseExpiresAtMs);
        Assert.Equal(
            0,
            await db.IdempotencyRecords.CountAsync(item => item.Scope == $"devices:{prepared.DeviceId:D}:tasks:{prepared.TaskId:D}:lease-renew"));
        Assert.Equal(
            Jarvis.Domain.Tasks.TaskStatus.Running,
            await db.Tasks.Where(item => item.Id == prepared.TaskId).Select(item => item.Status).SingleAsync());
    }

    private static async Task<PreparedTask> PrepareRunningTaskAsync(TestApplicationFactory factory)
    {
        using var client = factory.CreateClient();
        UseBearer(client, factory.Token);

        client.DefaultRequestHeaders.Add("Idempotency-Key", "lease-race-conversation");
        var conversationResponse = await client.PostAsJsonAsync(
            "/api/v1/conversations",
            new CreateConversationRequest("Lease race"),
            JsonOptions);
        Assert.Equal(HttpStatusCode.Created, conversationResponse.StatusCode);
        var conversation = await conversationResponse.Content.ReadFromJsonAsync<ConversationResponse>(JsonOptions);
        Assert.NotNull(conversation);

        client.DefaultRequestHeaders.Remove("Idempotency-Key");
        client.DefaultRequestHeaders.Add("Idempotency-Key", "lease-race-task");
        var taskResponse = await client.PostAsJsonAsync(
            "/api/v1/tasks",
            new CreateTaskRequest(
                conversation!.Id,
                [],
                "run a bounded task",
                "a result",
                ["localFiles"],
                CapabilityEnvelope: new CapabilityEnvelopeContract(ReadFiles: true, AllowedRoots: [Path.GetTempPath()])),
            JsonOptions);
        Assert.Equal(HttpStatusCode.Accepted, taskResponse.StatusCode);
        var accepted = await taskResponse.Content.ReadFromJsonAsync<TaskAcceptedResponse>(JsonOptions);
        Assert.NotNull(accepted);

        client.DefaultRequestHeaders.Remove("Idempotency-Key");
        client.DefaultRequestHeaders.Add("Idempotency-Key", "lease-race-device");
        var registrationResponse = await client.PostAsJsonAsync(
            "/api/v1/devices/register",
            new DeviceRegistrationRequest(
                "Lease race node",
                DeviceTypeValue.Desktop,
                "macos",
                ["localFiles"],
                [Path.GetTempPath()]),
            JsonOptions);
        Assert.Equal(HttpStatusCode.Created, registrationResponse.StatusCode);
        var device = await registrationResponse.Content.ReadFromJsonAsync<DeviceRegistrationResponse>(JsonOptions);
        Assert.NotNull(device);

        client.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", device!.DeviceCredential);
        client.DefaultRequestHeaders.Remove("Idempotency-Key");
        client.DefaultRequestHeaders.Add("Idempotency-Key", "lease-race-heartbeat");
        var heartbeatResponse = await client.PostAsJsonAsync(
            $"/api/v1/devices/{device.DeviceId:D}/heartbeat",
            new DeviceHeartbeatRequest(["localFiles"], [Path.GetTempPath()]),
            JsonOptions);
        Assert.Equal(HttpStatusCode.OK, heartbeatResponse.StatusCode);

        client.DefaultRequestHeaders.Remove("Idempotency-Key");
        client.DefaultRequestHeaders.Add("Idempotency-Key", "lease-race-claim");
        var claimResponse = await client.PostAsJsonAsync(
            "/api/v1/device-tasks/claim",
            new DeviceTaskClaimRequest(
                "lease-race-owner",
                new CapabilityEnvelopeContract(ReadFiles: true, AllowedRoots: [Path.GetTempPath()])),
            JsonOptions);
        Assert.Equal(HttpStatusCode.OK, claimResponse.StatusCode);
        var claim = await claimResponse.Content.ReadFromJsonAsync<DeviceTaskClaimResponse>(JsonOptions);
        Assert.NotNull(claim?.Execution);

        return new(device.DeviceId, device.DeviceCredential, accepted!.TaskId, claim!.Execution!.Id);
    }

    private static void ConfigureDeviceClient(
        HttpClient client,
        string credential,
        string leaseOwner,
        string idempotencyKey)
    {
        client.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", credential);
        client.DefaultRequestHeaders.Add("X-Lease-Owner", leaseOwner);
        client.DefaultRequestHeaders.Add("Idempotency-Key", idempotencyKey);
    }

    private static void UseBearer(HttpClient client, string token)
    {
        client.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", token);
    }

    private sealed record PreparedTask(Guid DeviceId, string DeviceCredential, Guid TaskId, Guid ExecutionId);

    private sealed class LeaseTaskReadGate : DbCommandInterceptor
    {
        private readonly TaskCompletionSource readReached = new(TaskCreationOptions.RunContinuationsAsynchronously);
        private readonly TaskCompletionSource release = new(TaskCreationOptions.RunContinuationsAsynchronously);
        private int armed;
        private int gated;

        public Task TaskReadReached => readReached.Task;

        public void Arm() => Volatile.Write(ref armed, 1);

        public void Release() => release.TrySetResult();

        public override async ValueTask<DbDataReader> ReaderExecutedAsync(
            DbCommand command,
            CommandExecutedEventData eventData,
            DbDataReader result,
            CancellationToken cancellationToken = default)
        {
            if (Volatile.Read(ref armed) == 1
                && command.CommandText.Contains("FROM \"Tasks\"", StringComparison.Ordinal)
                && Interlocked.Exchange(ref gated, 1) == 0)
            {
                readReached.TrySetResult();
                await release.Task.WaitAsync(cancellationToken);
            }

            return result;
        }
    }

    private sealed class AlwaysRejectTaskUpdateInterceptor : DbCommandInterceptor
    {
        private int armed;
        private int rejectionCount;

        public int RejectionCount => Volatile.Read(ref rejectionCount);

        public void Arm() => Volatile.Write(ref armed, 1);

        public override ValueTask<InterceptionResult<DbDataReader>> ReaderExecutingAsync(
            DbCommand command,
            CommandEventData eventData,
            InterceptionResult<DbDataReader> result,
            CancellationToken cancellationToken = default)
        {
            RejectIfArmed(command);
            return ValueTask.FromResult(result);
        }

        public override ValueTask<InterceptionResult<int>> NonQueryExecutingAsync(
            DbCommand command,
            CommandEventData eventData,
            InterceptionResult<int> result,
            CancellationToken cancellationToken = default)
        {
            RejectIfArmed(command);
            return ValueTask.FromResult(result);
        }

        private void RejectIfArmed(DbCommand command)
        {
            if (Volatile.Read(ref armed) == 1
                && command.CommandText.Contains("UPDATE \"Tasks\"", StringComparison.Ordinal))
            {
                Interlocked.Increment(ref rejectionCount);
                throw new DbUpdateConcurrencyException("Injected exhausted task version concurrency.");
            }
        }
    }
}
