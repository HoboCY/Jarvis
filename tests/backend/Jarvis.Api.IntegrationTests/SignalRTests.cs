using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Text.Json;
using Jarvis.Application.Outbox;
using Jarvis.Contracts;
using Jarvis.Infrastructure.Data;
using Microsoft.AspNetCore.SignalR.Client;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Xunit;

namespace Jarvis.Api.IntegrationTests;

public sealed class SignalRTests : IClassFixture<TestApplicationFactory>
{
    private readonly TestApplicationFactory _factory;

    public SignalRTests(TestApplicationFactory factory)
    {
        _factory = factory;
    }

    [Fact]
    public async Task AuthenticatedClientCanCompleteClientHubHandshake()
    {
        await using var connection = CreateConnection(includeToken: true);

        await connection.StartAsync();

        Assert.Equal(HubConnectionState.Connected, connection.State);
        await connection.StopAsync();
    }

    [Fact]
    public async Task UnauthenticatedClientCannotConnectToClientHub()
    {
        await using var connection = CreateConnection(includeToken: false);

        await Assert.ThrowsAnyAsync<Exception>(() => connection.StartAsync());
    }

    [Fact]
    public async Task BrowserStyleNegotiateAcceptsQueryTokenOnlyOnTheHubPath()
    {
        using var client = _factory.CreateClient();

        var response = await client.PostAsync(
            $"/hubs/client/negotiate?negotiateVersion=1&access_token={Uri.EscapeDataString(_factory.Token)}",
            content: null);

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
    }

    [Fact]
    public async Task HubAuthorizationHeaderTakesPriorityOverQueryToken()
    {
        using var client = _factory.CreateClient();
        client.DefaultRequestHeaders.Authorization = new("Bearer", new string('x', _factory.Token.Length));

        var response = await client.PostAsync(
            $"/hubs/client/negotiate?negotiateVersion=1&access_token={Uri.EscapeDataString(_factory.Token)}",
            content: null);

        Assert.Equal(HttpStatusCode.Unauthorized, response.StatusCode);
    }

    [Fact]
    public async Task RegisteredDeviceReceivesTaskAvailableHintForItsUserButStillClaimsOverHttp()
    {
        using var ui = _factory.CreateClient();
        ui.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", _factory.Token);
        ui.DefaultRequestHeaders.Add("Idempotency-Key", $"device-hub-register-{Guid.NewGuid():N}");
        var registration = await ui.PostAsJsonAsync(
            "/api/v1/devices/register",
            new DeviceRegistrationRequest("Hub Node", DeviceTypeValue.Desktop, "macos", ["localFiles"], [Path.GetTempPath()]),
            JsonOptions);
        registration.EnsureSuccessStatusCode();
        var device = (await registration.Content.ReadFromJsonAsync<DeviceRegistrationResponse>(JsonOptions))!;
        using var node = _factory.CreateClient();
        node.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", device.DeviceCredential);
        node.DefaultRequestHeaders.Add("Idempotency-Key", $"device-hub-heartbeat-{Guid.NewGuid():N}");
        (await node.PostAsJsonAsync(
            $"/api/v1/devices/{device.DeviceId:D}/heartbeat",
            new DeviceHeartbeatRequest(["localFiles"], [Path.GetTempPath()]),
            JsonOptions)).EnsureSuccessStatusCode();

        await using var connection = new HubConnectionBuilder()
            .WithUrl(new Uri(_factory.Server.BaseAddress, "/hubs/device"), options =>
            {
                options.HttpMessageHandlerFactory = _ => _factory.Server.CreateHandler();
                options.AccessTokenProvider = () => Task.FromResult<string?>(device.DeviceCredential);
            })
            .Build();
        var available = new TaskCompletionSource<OutboxEventEnvelope>(TaskCreationOptions.RunContinuationsAsynchronously);
        connection.On<OutboxEventEnvelope>("task.available", envelope => available.TrySetResult(envelope));
        await connection.StartAsync();

        ui.DefaultRequestHeaders.Remove("Idempotency-Key");
        ui.DefaultRequestHeaders.Add("Idempotency-Key", $"device-hub-conversation-{Guid.NewGuid():N}");
        var conversation = await (await ui.PostAsJsonAsync(
            "/api/v1/conversations",
            new CreateConversationRequest("Device Hub"),
            JsonOptions)).Content.ReadFromJsonAsync<ConversationResponse>(JsonOptions);
        ui.DefaultRequestHeaders.Remove("Idempotency-Key");
        ui.DefaultRequestHeaders.Add("Idempotency-Key", $"device-hub-task-{Guid.NewGuid():N}");
        var accepted = await (await ui.PostAsJsonAsync(
            "/api/v1/tasks",
            new CreateTaskRequest(
                conversation!.Id,
                [],
                "read report",
                null,
                ["localFiles"],
                CapabilityEnvelope: new CapabilityEnvelopeContract(ReadFiles: true, AllowedRoots: [Path.GetTempPath()])),
            JsonOptions)).Content.ReadFromJsonAsync<TaskAcceptedResponse>(JsonOptions);

        await using var scope = _factory.Services.CreateAsyncScope();
        var db = scope.ServiceProvider.GetRequiredService<JarvisDbContext>();
        var availableMessages = await db.OutboxMessages
            .Where(item => item.EventType == "task.available")
            .ToListAsync();
        var outbox = Assert.Single(availableMessages, item =>
            item.PayloadJson.Contains(accepted!.TaskId.ToString(), StringComparison.Ordinal));
        await scope.ServiceProvider.GetRequiredService<IOutboxPublisher>().PublishAsync(outbox, CancellationToken.None);

        var hint = await available.Task.WaitAsync(TimeSpan.FromSeconds(5));
        Assert.Equal("task.available", hint.Type);
        node.DefaultRequestHeaders.Remove("Idempotency-Key");
        node.DefaultRequestHeaders.Add("Idempotency-Key", $"device-hub-claim-{Guid.NewGuid():N}");
        var claim = await (await node.PostAsJsonAsync(
            "/api/v1/device-tasks/claim",
            new DeviceTaskClaimRequest("hub-node", new CapabilityEnvelopeContract(ReadFiles: true, AllowedRoots: [Path.GetTempPath()])),
            JsonOptions)).Content.ReadFromJsonAsync<DeviceTaskClaimResponse>(JsonOptions);
        Assert.True(claim!.Claimed);
        Assert.Equal(accepted!.TaskId, claim.Task!.Id);
    }

    private HubConnection CreateConnection(bool includeToken)
    {
        return new HubConnectionBuilder()
            .WithUrl(
                new Uri(_factory.Server.BaseAddress, "/hubs/client"),
                options =>
                {
                    options.HttpMessageHandlerFactory = _ => _factory.Server.CreateHandler();
                    if (includeToken)
                    {
                        options.AccessTokenProvider = () => Task.FromResult<string?>(_factory.Token);
                    }
                })
            .Build();
    }

    private static readonly JsonSerializerOptions JsonOptions = new(JsonSerializerDefaults.Web);
}
