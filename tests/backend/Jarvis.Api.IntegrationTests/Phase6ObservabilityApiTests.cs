using System.Collections.Concurrent;
using System.Diagnostics.Metrics;
using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Text.Json;
using Jarvis.Api.Diagnostics;
using Jarvis.Contracts;
using Jarvis.Application.Realtime;
using Jarvis.Infrastructure.Observability;
using Jarvis.Infrastructure.Tasks;
using Microsoft.AspNetCore.TestHost;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Xunit;

namespace Jarvis.Api.IntegrationTests;

public sealed class Phase6ObservabilityApiTests : IClassFixture<TestApplicationFactory>
{
    private readonly TestApplicationFactory factory;

    public Phase6ObservabilityApiTests(TestApplicationFactory factory)
    {
        this.factory = factory;
    }

    [Fact]
    public async Task CorrelationIdIsBoundedEchoedAndGeneratedWhenMissing()
    {
        using var client = factory.CreateClient();
        client.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", factory.Token);
        using var supplied = new HttpRequestMessage(HttpMethod.Get, "/api/v1/phase0/health");
        supplied.Headers.Add("X-Correlation-ID", "test-correlation-123");

        using var suppliedResponse = await client.SendAsync(supplied);
        using var generatedResponse = await client.GetAsync("/api/v1/phase0/health");

        Assert.Equal(HttpStatusCode.OK, suppliedResponse.StatusCode);
        Assert.Equal("test-correlation-123", suppliedResponse.Headers.GetValues("X-Correlation-ID").Single());
        var generated = generatedResponse.Headers.GetValues("X-Correlation-ID").Single();
        Assert.NotEqual("test-correlation-123", generated);
        Assert.InRange(generated.Length, 1, 128);
    }

    [Fact]
    public async Task DiagnosticsRequiresLocalBearerAndReturnsSafeAggregates()
    {
        using var anonymous = factory.CreateClient();
        using var authenticated = factory.CreateClient();
        authenticated.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", factory.Token);

        var unauthorized = await anonymous.GetAsync("/api/v1/diagnostics");
        var response = await authenticated.GetAsync("/api/v1/diagnostics");
        var json = await response.Content.ReadAsStringAsync();

        Assert.Equal(HttpStatusCode.Unauthorized, unauthorized.StatusCode);
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        Assert.DoesNotContain(factory.Token, json, StringComparison.Ordinal);
        Assert.DoesNotContain("Bearer", json, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain("/Users/", json, StringComparison.Ordinal);
    }

    [Fact]
    public async Task DiagnosticsRejectsAValidBearerWhenTestingConnectionIsNonLoopback()
    {
        using var remoteFactory = factory.WithWebHostBuilder(builder =>
            builder.ConfigureTestServices(services =>
                services.PostConfigure<DiagnosticsOptions>(options =>
                    options.TestServerRemoteAddress = "192.0.2.44")));
        using var client = remoteFactory.CreateClient();
        client.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", factory.Token);

        using var response = await client.GetAsync("/api/v1/diagnostics");

        Assert.Equal(HttpStatusCode.Forbidden, response.StatusCode);
    }

    [Fact]
    public async Task HealthEndpointsRequireLocalBearer()
    {
        using var anonymous = factory.CreateClient();
        using var authenticated = factory.CreateClient();
        authenticated.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", factory.Token);

        Assert.Equal(HttpStatusCode.Unauthorized, (await anonymous.GetAsync("/health/live")).StatusCode);
        Assert.Equal(HttpStatusCode.Unauthorized, (await anonymous.GetAsync("/health/ready")).StatusCode);
        Assert.Equal(HttpStatusCode.OK, (await authenticated.GetAsync("/health/live")).StatusCode);
        Assert.Equal(HttpStatusCode.OK, (await authenticated.GetAsync("/health/ready")).StatusCode);
    }

    [Fact]
    public async Task DiagnosticsReportsActualHostedWorkerLifecycleState()
    {
        using var workerFactory = factory.WithWebHostBuilder(builder =>
            builder.ConfigureAppConfiguration((_, configuration) => configuration.AddInMemoryCollection(new Dictionary<string, string?>
            {
                ["FakeWorker:Enabled"] = "true",
                ["Outbox:Enabled"] = "true",
                ["ResponsesWorker:Enabled"] = "true",
                ["SummaryWorker:Enabled"] = "true"
            })));
        using var client = workerFactory.CreateClient();
        client.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", factory.Token);
        await using (var scope = workerFactory.Services.CreateAsyncScope())
        {
            _ = scope.ServiceProvider.GetRequiredService<IRealtimeClientSecretProvider>();
        }

        JsonElement diagnostics = default;
        for (var attempt = 0; attempt < 20; attempt++)
        {
            using var response = await client.GetAsync("/api/v1/diagnostics");
            response.EnsureSuccessStatusCode();
            diagnostics = await response.Content.ReadFromJsonAsync<JsonElement>();
            if (diagnostics.GetProperty("workers").EnumerateObject().Any())
            {
                break;
            }

            await Task.Delay(25);
        }

        var workers = diagnostics.GetProperty("workers");
        Assert.Equal("running", workers.GetProperty("fake").GetString());
        Assert.Equal("running", workers.GetProperty("outbox").GetString());
        Assert.Equal("running", workers.GetProperty("responses").GetString());
        Assert.Equal("running", workers.GetProperty("summary").GetString());

        var observer = workerFactory.Services.GetRequiredService<IRuntimeStateObserver>();
        var snapshot = observer.Snapshot();
        Assert.Equal("running", snapshot.Workers["Fake"]);
        Assert.Contains(snapshot.Circuits, item => item.Value is "closed" or "disabled");
    }

    [Fact]
    public async Task MetricsAreEmittedByTaskNotificationAndOutboxBusinessEvents()
    {
        var measurements = new ConcurrentBag<string>();
        using var listener = new MeterListener
        {
            InstrumentPublished = (instrument, meterListener) =>
            {
                if (instrument.Meter.Name == JarvisTelemetry.MeterName)
                {
                    meterListener.EnableMeasurementEvents(instrument);
                }
            }
        };
        listener.SetMeasurementEventCallback<long>((instrument, _, _, _) => measurements.Add(instrument.Name));
        listener.SetMeasurementEventCallback<double>((instrument, _, _, _) => measurements.Add(instrument.Name));
        listener.Start();

        using var client = factory.CreateClient();
        client.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", factory.Token);
        using var conversationResponse = await PostAsync(
            client,
            "/api/v1/conversations",
            new CreateConversationRequest("metrics"),
            "metrics-conversation");
        conversationResponse.EnsureSuccessStatusCode();
        var conversation = await conversationResponse.Content.ReadFromJsonAsync<ConversationResponse>();
        Assert.NotNull(conversation);

        using var taskResponse = await PostAsync(
            client,
            "/api/v1/tasks",
            new CreateTaskRequest(
                conversation!.Id,
                [],
                "metrics task",
                "done",
                [],
                CapabilityEnvelope: null),
            "metrics-task");
        Assert.Equal(HttpStatusCode.Accepted, taskResponse.StatusCode);
        var accepted = await taskResponse.Content.ReadFromJsonAsync<TaskAcceptedResponse>();
        Assert.NotNull(accepted);

        await using (var scope = factory.Services.CreateAsyncScope())
        {
            Assert.True(await scope.ServiceProvider.GetRequiredService<FakeDelayWorker>().ProcessOneAsync());
        }

        var unread = await client.GetFromJsonAsync<NotificationListResponse>("/api/v1/notifications?status=unread");
        var notification = Assert.Single(unread!.Items, item => item.TaskId == accepted!.TaskId);
        using (var delivered = await PostAsync(
                   client,
                   $"/api/v1/notifications/{notification.Id:D}/delivered",
                   new { },
                   "metrics-delivered"))
        {
            delivered.EnsureSuccessStatusCode();
        }

        using (var deliveredReplay = await PostAsync(
                   client,
                   $"/api/v1/notifications/{notification.Id:D}/delivered",
                   new { },
                   "metrics-delivered"))
        {
            deliveredReplay.EnsureSuccessStatusCode();
        }

        using (var read = await PostAsync(
                   client,
                   $"/api/v1/notifications/{notification.Id:D}/read",
                   new { },
                   "metrics-read"))
        {
            read.EnsureSuccessStatusCode();
        }

        Assert.Contains("jarvis.tasks.created", measurements);
        Assert.Contains("jarvis.tasks.queue.depth", measurements);
        Assert.Contains("jarvis.tasks.queue.wait", measurements);
        Assert.Contains("jarvis.tasks.succeeded", measurements);
        Assert.Contains("jarvis.notifications.outbox.backlog", measurements);
        Assert.Contains("jarvis.notifications.delivery.duration", measurements);
        Assert.Contains("jarvis.notifications.delivered", measurements);
        Assert.Contains("jarvis.notifications.read", measurements);
        Assert.Contains("jarvis.notifications.duplicates.suppressed", measurements);
    }

    private static async Task<HttpResponseMessage> PostAsync(
        HttpClient client,
        string path,
        object body,
        string idempotencyKey)
    {
        using var request = new HttpRequestMessage(HttpMethod.Post, path)
        {
            Content = JsonContent.Create(body)
        };
        request.Headers.Add("Idempotency-Key", idempotencyKey);
        return await client.SendAsync(request);
    }
}
