using System.ClientModel;
using System.ClientModel.Primitives;
using System.Net;
using System.Text;
using System.Text.Json;
using System.Runtime.InteropServices;
using Jarvis.Application.Realtime;
using Jarvis.Application.Responses;
using Jarvis.Infrastructure;
using Jarvis.Infrastructure.Responses;
using Jarvis.Infrastructure.Realtime;
using Jarvis.Infrastructure.Budgets;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Options;
#pragma warning disable OPENAI001
using OpenAI.Responses;
using Xunit;

namespace Jarvis.Infrastructure.Tests;

public sealed class Phase9bBudgetAdmissionTests
{
    [Fact]
    public async Task DisabledAdmissionLeavesTheProviderTransportUntouched()
    {
        var admission = new RecordingAdmission(false);
        var transport = new CountingHandler();
        using var handler = new Phase9bProviderAdmissionHandler(admission)
        {
            InnerHandler = transport
        };
        using var client = new HttpClient(handler);

        using var response = await client.GetAsync("https://provider.test/responses");

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        Assert.Empty(admission.Reservations);
        Assert.Equal(1, transport.CallCount);
    }

    [Fact]
    public async Task RejectedReservationPreventsTheProviderTransport()
    {
        var admission = new RecordingAdmission(true)
        {
            Failure = new Phase9bBudgetAdmissionException("BUDGET_EXHAUSTED")
        };
        var transport = new CountingHandler();
        using var handler = new Phase9bProviderAdmissionHandler(admission)
        {
            InnerHandler = transport
        };
        using var client = new HttpClient(handler);

        var exception = await Assert.ThrowsAsync<Phase9bBudgetAdmissionException>(
            () => client.GetAsync("https://provider.test/responses"));

        Assert.Equal("BUDGET_EXHAUSTED", exception.Code);
        Assert.Empty(transport.Requests);
        Assert.Single(admission.Reservations);
    }

    [Fact]
    public async Task RepeatedHttpAttemptsReserveProviderAndRetryBeforeEachSend()
    {
        var admission = new RecordingAdmission(true);
        var transport = new CountingHandler();
        using var handler = new Phase9bProviderAdmissionHandler(admission)
        {
            InnerHandler = transport
        };
        using var client = new HttpMessageInvoker(handler);
        using var request = new HttpRequestMessage(HttpMethod.Post, "https://provider.test/responses");

        using var first = await client.SendAsync(request, CancellationToken.None);
        using var second = await client.SendAsync(request, CancellationToken.None);

        Assert.Equal(2, transport.CallCount);
        Assert.Equal(
            ["providerRequests", "providerRequests", "retries"],
            admission.Reservations.Select(item => item.Kind).ToArray());
        Assert.Equal(admission.Reservations[0].LogicalId, admission.Reservations[1].LogicalId);
        Assert.Equal(admission.Reservations[1].LogicalId, admission.Reservations[2].LogicalId);
    }

    [Fact]
    public async Task IndependentRealtimeClientSecretRequestsUseFreshWireReservations()
    {
        var admission = new RecordingAdmission(true);
        var transport = new CountingHandler();
        using var firstHandler = new Phase9bProviderAdmissionHandler(admission)
        {
            InnerHandler = transport
        };
        using var firstClient = new HttpClient(firstHandler);
        using var secondHandler = new Phase9bProviderAdmissionHandler(admission)
        {
            InnerHandler = transport
        };
        using var secondClient = new HttpClient(secondHandler);

        await firstClient.PostAsync("https://resource.openai.azure.com/openai/v1/realtime/client_secrets", null);
        await secondClient.PostAsync("https://resource.openai.azure.com/openai/v1/realtime/client_secrets", null);

        Assert.Equal(2, transport.CallCount);
        Assert.Equal(2, admission.Reservations.Count);
        Assert.NotEqual(admission.Reservations[0].LogicalId, admission.Reservations[1].LogicalId);
        Assert.NotEqual(admission.Reservations[0].RequestKey, admission.Reservations[1].RequestKey);
    }

    [Fact]
    public async Task RecreatedHandlerWithTheSameIdempotencyKeyStillGetsAFreshWireReservation()
    {
        var admission = new RecordingAdmission(true);
        var transport = new CountingHandler();
        using (var firstHandler = new Phase9bProviderAdmissionHandler(admission)
        {
            InnerHandler = transport
        })
        using (var firstClient = new HttpMessageInvoker(firstHandler))
        {
            using var request = new HttpRequestMessage(HttpMethod.Post, "https://api.deepseek.com/responses");
            request.Headers.Add("Idempotency-Key", "stable-fixture-key");
            using var response = await firstClient.SendAsync(request, CancellationToken.None);
        }

        using (var secondHandler = new Phase9bProviderAdmissionHandler(admission)
        {
            InnerHandler = transport
        })
        using (var secondClient = new HttpMessageInvoker(secondHandler))
        {
            using var request = new HttpRequestMessage(HttpMethod.Post, "https://api.deepseek.com/responses");
            request.Headers.Add("Idempotency-Key", "stable-fixture-key");
            using var response = await secondClient.SendAsync(request, CancellationToken.None);
        }

        Assert.Equal(2, transport.CallCount);
        Assert.Equal(3, admission.Reservations.Count);
        Assert.Equal(admission.Reservations[0].LogicalId, admission.Reservations[1].LogicalId);
        Assert.Equal(admission.Reservations[0].LogicalId, admission.Reservations[2].LogicalId);
        Assert.NotEqual(admission.Reservations[0].RequestKey, admission.Reservations[1].RequestKey);
        Assert.Equal("retries", admission.Reservations[2].Kind);
    }

    [Fact]
    public async Task StableIdempotencyKeysProduceAdmissionCompatibleLogicalIds()
    {
        var admission = new RecordingAdmission(true);
        var transport = new CountingHandler();
        using var handler = new Phase9bProviderAdmissionHandler(admission)
        {
            InnerHandler = transport
        };
        using var client = new HttpMessageInvoker(handler);

        for (var index = 0; index < 64; index++)
        {
            using var request = new HttpRequestMessage(HttpMethod.Post, "https://api.deepseek.com/responses");
            request.Headers.Add("Idempotency-Key", $"stable-fixture-{index}");
            using var response = await client.SendAsync(request, CancellationToken.None);
        }

        Assert.Equal(64, transport.CallCount);
        Assert.Equal(64, admission.Reservations.Count(item => item.Kind == "providerRequests"));
        Assert.All(
            admission.Reservations.Where(item => item.Kind == "providerRequests"),
            item =>
            {
                var text = item.LogicalId.ToString("D");
                Assert.Contains(text[14], "12345678");
                Assert.Contains(char.ToLowerInvariant(text[19]), "89ab");
            });
    }

    [Fact]
    public async Task ClientUsesOnlyTheOwnerTokenAndRejectsUnknownDescriptorFields()
    {
        var root = new DirectoryInfo(CanonicalizeTemporaryPath(
            Directory.CreateTempSubdirectory("jarvis-phase9b-budget-").FullName));
        try
        {
            SetOwnerOnly(root.FullName, directory: true);
            var runId = Guid.NewGuid().ToString("D");
            var markerPath = Path.Combine(root.FullName, ".phase9b-owner.json");
            await File.WriteAllTextAsync(
                markerPath,
                JsonSerializer.Serialize(new { schemaVersion = 1, runId, pid = 1, createdAtUtc = "2026-01-01T00:00:00Z" }));
            SetOwnerOnly(markerPath, directory: false);
            var admissionDirectory = Path.Combine(root.FullName, "runtime", "admission");
            Directory.CreateDirectory(admissionDirectory);
            SetOwnerOnly(admissionDirectory, directory: true);
            var tokenPath = Path.Combine(admissionDirectory, "token.json");
            var ledgerPath = Path.Combine(admissionDirectory, "ledger.json");
            await File.WriteAllTextAsync(tokenPath, "\"fixture-admission-token-12345678901234567890\"\n");
            await File.WriteAllTextAsync(ledgerPath, "{}\n");
            SetOwnerOnly(tokenPath, directory: false);
            SetOwnerOnly(ledgerPath, directory: false);
            var descriptorPath = Path.Combine(admissionDirectory, "descriptor.json");
            await File.WriteAllTextAsync(
                descriptorPath,
                JsonSerializer.Serialize(new
                {
                    schemaVersion = 1,
                    runId,
                    ownerPid = 1,
                    ownerUid = GetUid(),
                    root = root.FullName,
                    endpoint = "http://127.0.0.1:45678",
                    tokenFile = "runtime/admission/token.json",
                    ledgerFile = "runtime/admission/ledger.json"
                }) + "\n");
            SetOwnerOnly(descriptorPath, directory: false);

            using var fakeHttp = new CountingHandler();
            using var client = new Phase9bBudgetAdmissionClient(
                new Phase9bBudgetAdmissionOptions { Enabled = true, DescriptorPath = descriptorPath, RunId = runId },
                fakeHttp);

            var logicalId = Guid.NewGuid();
            var reservation = await client.ReserveAsync(
                "providerRequests", logicalId, "provider:fixture", CancellationToken.None);
            Assert.Equal("providerRequests", reservation.Kind);
            Assert.Equal(logicalId, reservation.LogicalId);
            Assert.Single(fakeHttp.Requests);

            await File.WriteAllTextAsync(
                descriptorPath,
                JsonSerializer.Serialize(new
                {
                    schemaVersion = 1,
                    runId,
                    ownerPid = 1,
                    ownerUid = GetUid(),
                    root = root.FullName,
                    endpoint = "http://127.0.0.1:45678",
                    tokenFile = "runtime/admission/token.json",
                    ledgerFile = "runtime/admission/ledger.json",
                    unknown = true
                }) + "\n");
            SetOwnerOnly(descriptorPath, directory: false);
            await Assert.ThrowsAsync<Phase9bBudgetAdmissionException>(() => client.ReserveAsync(
                "providerRequests", Guid.NewGuid(), "provider:fixture-2", CancellationToken.None));
            Assert.Single(fakeHttp.Requests);
        }
        finally
        {
            root.Delete(true);
        }
    }

    [Fact]
    public async Task ProductionAzureClientSecretRegistrationRejectsBeforeItsHttpTransport()
    {
        var admission = new RecordingAdmission(true)
        {
            Failure = new Phase9bBudgetAdmissionException("BUDGET_EXHAUSTED")
        };
        using var services = BuildProviderServices("OpenAI", admission);
        var provider = services.GetRequiredService<IRealtimeClientSecretProvider>();

        var exception = await Assert.ThrowsAsync<Phase9bBudgetAdmissionException>(() => provider.CreateAsync(
            new RealtimeClientSecretProviderRequest(
                Guid.NewGuid(),
                new ContextPackage(1, "fixture", "", "", [], "", ""),
                "fixture-safety",
                null),
            CancellationToken.None));

        Assert.Equal("BUDGET_EXHAUSTED", exception.Code);
        var reservation = Assert.Single(admission.Reservations);
        Assert.Equal("providerRequests", reservation.Kind);
    }

    [Fact]
    public async Task ProductionDeepSeekResponsesRegistrationUsesTheAdmissionTransport()
    {
        var admission = new RecordingAdmission(true)
        {
            Failure = new Phase9bBudgetAdmissionException("BUDGET_EXHAUSTED")
        };
        using var services = BuildProviderServices("DeepSeek", admission);
        var runtime = services.GetRequiredService<IResponsesRuntime>();

        var exception = await Assert.ThrowsAsync<Phase9bBudgetAdmissionException>(() => runtime.CreateAsync(
            new ResponsesCreateRequest("deepseek-v4-flash", "fixture", "fixture input", "fixture-key"),
            CancellationToken.None));

        Assert.Equal("BUDGET_EXHAUSTED", exception.Code);
        var reservation = Assert.Single(admission.Reservations);
        Assert.Equal("providerRequests", reservation.Kind);
    }

    [Fact]
    public async Task ResponsesRuntimeRetryReentersTheAdmissionHandlerBeforeEachSdkRequest()
    {
        var admission = new RecordingAdmission(true);
        var providerTransport = new ScriptedProviderHandler(
            new HttpResponseMessage(HttpStatusCode.TooManyRequests)
            {
                Content = new StringContent("{\"error\":{\"message\":\"retry\"}}", Encoding.UTF8, "application/json")
            },
            new HttpResponseMessage(HttpStatusCode.OK)
            {
                Content = new StringContent(
                    "{\"id\":\"resp_fixture\",\"object\":\"response\",\"status\":\"completed\",\"model\":\"deepseek-v4-flash\",\"output\":[]}",
                    Encoding.UTF8,
                    "application/json")
            });
        using var admissionHandler = new Phase9bProviderAdmissionHandler(admission)
        {
            InnerHandler = providerTransport
        };
        using var transportClient = new HttpClient(admissionHandler);
        var pipeline = ClientPipeline.Create(
            new ClientPipelineOptions
            {
                RetryPolicy = new ClientRetryPolicy(0),
                Transport = new HttpClientPipelineTransport(transportClient)
            },
            perCallPolicies: ReadOnlySpan<PipelinePolicy>.Empty,
            perTryPolicies: new[]
            {
                ApiKeyAuthenticationPolicy.CreateBearerAuthorizationPolicy(new ApiKeyCredential("fixture-key"))
            },
            beforeTransportPolicies: ReadOnlySpan<PipelinePolicy>.Empty);
        var runtime = new DeepSeekResponsesRuntime(
            Options.Create(new ResponsesOptions
            {
                Model = "deepseek-v4-flash",
                SummarizerModel = "deepseek-v4-flash",
                TimeoutSeconds = 2,
                MaxTransientRetries = 1,
                PollingIntervalMs = 25
            }),
            new PipelineResponsesClientFactory(pipeline));

        var result = await runtime.CreateAsync(
            new ResponsesCreateRequest("deepseek-v4-flash", "fixture", "input", "stable-retry-key"),
            CancellationToken.None);

        Assert.Equal(ResponsesStatus.Completed, result.Status);
        Assert.Equal(2, providerTransport.CallCount);
        Assert.Equal(
            ["providerRequests", "providerRequests", "retries"],
            admission.Reservations.Select(item => item.Kind));
        Assert.Equal(admission.Reservations[0].LogicalId, admission.Reservations[1].LogicalId);
        Assert.Equal(admission.Reservations[0].LogicalId, admission.Reservations[2].LogicalId);
    }

    private static ServiceProvider BuildProviderServices(
        string responsesProvider,
        RecordingAdmission admission)
    {
        var values = new Dictionary<string, string?>(StringComparer.Ordinal)
        {
            ["OpenAI:ApiKey"] = "fixture-openai-key",
            ["OpenAI:AuthenticationMode"] = "ApiKey",
            ["OpenAI:BaseUrl"] = "https://api.openai.com/",
            ["OpenAI:RealtimeModel"] = "gpt-realtime-2.1-mini",
            ["OpenAI:RealtimeVoice"] = "alloy",
            ["OpenAI:AllowedVoices:0"] = "alloy",
            ["OpenAI:SafetyIdentifierSalt"] = "fixture-salt",
            ["OpenAI:ClientSecretLifetimeSeconds"] = "600",
            ["Responses:Provider"] = responsesProvider,
            ["Responses:Model"] = "deepseek-v4-flash",
            ["Responses:SummarizerModel"] = "deepseek-v4-flash",
            ["Responses:TimeoutSeconds"] = "1",
            ["Responses:MaxTransientRetries"] = "0",
            ["Responses:PollingIntervalMs"] = "25",
            ["DeepSeek:ApiKey"] = "fixture-deepseek-key",
            ["DeepSeek:BaseUrl"] = "https://api.deepseek.com/"
        };
        var configuration = new ConfigurationBuilder().AddInMemoryCollection(values).Build();
        var collection = new ServiceCollection();
        collection.AddJarvisInfrastructure(configuration);
        collection.AddSingleton<IPhase9bBudgetAdmission>(admission);
        var provider = collection.BuildServiceProvider();
        provider.GetRequiredService<IStartupValidator>().Validate();
        return provider;
    }

    private sealed class PipelineResponsesClientFactory(ClientPipeline pipeline) : IResponsesClientFactory
    {
        public ResponsesClient Create(string model) => new TestResponsesClient(
            pipeline,
            new ResponsesClientOptions { Endpoint = new Uri("https://api.deepseek.com/") });
    }

    private sealed class TestResponsesClient(
        ClientPipeline pipeline,
        ResponsesClientOptions options) : ResponsesClient(pipeline, options);

    private sealed class ScriptedProviderHandler(params HttpResponseMessage[] responses) : HttpMessageHandler
    {
        private readonly Queue<HttpResponseMessage> remaining = new(responses);

        public int CallCount { get; private set; }

        protected override Task<HttpResponseMessage> SendAsync(
            HttpRequestMessage request,
            CancellationToken cancellationToken)
        {
            CallCount++;
            return Task.FromResult(remaining.Count > 0
                ? remaining.Dequeue()
                : new HttpResponseMessage(HttpStatusCode.OK));
        }
    }

    [Fact]
    public async Task RejectsGroupReadableDescriptorBeforeAnyAdmissionRequest()
    {
        if (OperatingSystem.IsWindows())
        {
            return;
        }

        var fixture = await CreateAdmissionFixtureAsync();
        try
        {
            File.SetUnixFileMode(
                fixture.DescriptorPath,
                UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.GroupRead);
            using var fakeHttp = new CountingHandler();
            using var client = CreateAdmissionClient(fixture, fakeHttp);

            var exception = await Assert.ThrowsAsync<Phase9bBudgetAdmissionException>(() => client.ReserveAsync(
                "providerRequests", Guid.NewGuid(), "provider:mode", CancellationToken.None));

            Assert.Equal("ADMISSION_INVALID", exception.Code);
            Assert.Empty(fakeHttp.Requests);
        }
        finally
        {
            Directory.Delete(fixture.Root, recursive: true);
        }
    }

    [Fact]
    public async Task RejectsDescriptorReachedThroughParentSymlink()
    {
        var fixture = await CreateAdmissionFixtureAsync();
        var alias = Path.Combine(fixture.Root, "runtime-alias");
        try
        {
            Directory.CreateSymbolicLink(alias, Path.Combine(fixture.Root, "runtime"));
            using var fakeHttp = new CountingHandler();
            using var client = new Phase9bBudgetAdmissionClient(
                new Phase9bBudgetAdmissionOptions
                {
                    Enabled = true,
                    DescriptorPath = Path.Combine(alias, "admission", "descriptor.json"),
                    RunId = fixture.RunId
                },
                fakeHttp);

            var exception = await Assert.ThrowsAsync<Phase9bBudgetAdmissionException>(() => client.ReserveAsync(
                "providerRequests", Guid.NewGuid(), "provider:symlink", CancellationToken.None));

            Assert.Equal("ADMISSION_OWNERSHIP_INVALID", exception.Code);
            Assert.Empty(fakeHttp.Requests);
        }
        finally
        {
            Directory.Delete(fixture.Root, recursive: true);
        }
    }

    [Fact]
    public async Task RejectsDescriptorOwnerAndMarkerMismatches()
    {
        var fixture = await CreateAdmissionFixtureAsync();
        try
        {
            await WriteDescriptorAsync(fixture, ownerUid: fixture.OwnerUid + 1, markerPid: fixture.MarkerPid);
            using var ownerHttp = new CountingHandler();
            using var ownerClient = CreateAdmissionClient(fixture, ownerHttp);
            var ownerException = await Assert.ThrowsAsync<Phase9bBudgetAdmissionException>(() => ownerClient.ReserveAsync(
                "providerRequests", Guid.NewGuid(), "provider:owner", CancellationToken.None));
            Assert.Equal("ADMISSION_OWNERSHIP_INVALID", ownerException.Code);
            Assert.Empty(ownerHttp.Requests);

            await WriteDescriptorAsync(fixture, ownerUid: fixture.OwnerUid, markerPid: fixture.MarkerPid + 1);
            using var markerHttp = new CountingHandler();
            using var markerClient = CreateAdmissionClient(fixture, markerHttp);
            var markerException = await Assert.ThrowsAsync<Phase9bBudgetAdmissionException>(() => markerClient.ReserveAsync(
                "providerRequests", Guid.NewGuid(), "provider:marker", CancellationToken.None));
            Assert.Equal("ADMISSION_OWNERSHIP_INVALID", markerException.Code);
            Assert.Empty(markerHttp.Requests);
        }
        finally
        {
            Directory.Delete(fixture.Root, recursive: true);
        }
    }

    private static Phase9bBudgetAdmissionClient CreateAdmissionClient(
        AdmissionFixture fixture,
        HttpMessageHandler fakeHttp) =>
        new(
            new Phase9bBudgetAdmissionOptions
            {
                Enabled = true,
                DescriptorPath = fixture.DescriptorPath,
                RunId = fixture.RunId
            },
            fakeHttp);

    private static async Task<AdmissionFixture> CreateAdmissionFixtureAsync()
    {
        var created = Directory.CreateTempSubdirectory("jarvis-phase9b-budget-security-");
        var root = CanonicalizeTemporaryPath(created.FullName);
        var runId = Guid.NewGuid().ToString("D");
        var ownerUid = GetUid();
        var markerPid = 1L;
        var admissionDirectory = Path.Combine(root, "runtime", "admission");
        Directory.CreateDirectory(admissionDirectory);
        SetOwnerOnly(root, directory: true);
        SetOwnerOnly(Path.Combine(root, "runtime"), directory: true);
        SetOwnerOnly(admissionDirectory, directory: true);
        var markerPath = Path.Combine(root, ".phase9b-owner.json");
        await File.WriteAllTextAsync(
            markerPath,
            JsonSerializer.Serialize(new { schemaVersion = 1, runId, pid = markerPid, createdAtUtc = "2026-01-01T00:00:00Z" }));
        SetOwnerOnly(markerPath, directory: false);
        var tokenPath = Path.Combine(admissionDirectory, "token.json");
        var ledgerPath = Path.Combine(admissionDirectory, "ledger.json");
        await File.WriteAllTextAsync(tokenPath, "\"fixture-admission-token-12345678901234567890\"\n");
        await File.WriteAllTextAsync(ledgerPath, "{}\n");
        SetOwnerOnly(tokenPath, directory: false);
        SetOwnerOnly(ledgerPath, directory: false);
        var fixture = new AdmissionFixture(
            root,
            runId,
            ownerUid,
            markerPid,
            Path.Combine(admissionDirectory, "descriptor.json"));
        await WriteDescriptorAsync(fixture, ownerUid, markerPid);
        return fixture;
    }

    private static async Task WriteDescriptorAsync(
        AdmissionFixture fixture,
        long ownerUid,
        long markerPid)
    {
        var descriptor = new
        {
            schemaVersion = 1,
            runId = fixture.RunId,
            ownerPid = fixture.MarkerPid,
            ownerUid,
            root = fixture.Root,
            endpoint = "http://127.0.0.1:45678",
            tokenFile = "runtime/admission/token.json",
            ledgerFile = "runtime/admission/ledger.json"
        };
        await File.WriteAllTextAsync(fixture.DescriptorPath, JsonSerializer.Serialize(descriptor) + "\n");
        SetOwnerOnly(fixture.DescriptorPath, directory: false);
        var markerPath = Path.Combine(fixture.Root, ".phase9b-owner.json");
        await File.WriteAllTextAsync(
            markerPath,
            JsonSerializer.Serialize(new
            {
                schemaVersion = 1,
                runId = fixture.RunId,
                pid = markerPid,
                createdAtUtc = "2026-01-01T00:00:00Z"
            }) + "\n");
        SetOwnerOnly(markerPath, directory: false);
    }

    private static string CanonicalizeTemporaryPath(string path) =>
        OperatingSystem.IsMacOS() && path.StartsWith("/var/", StringComparison.Ordinal)
            ? "/private" + path
            : path;

    private sealed record AdmissionFixture(
        string Root,
        string RunId,
        long OwnerUid,
        long MarkerPid,
        string DescriptorPath);

    private static long GetUid() => OperatingSystem.IsWindows() ? 0 : geteuid();

    private static void SetOwnerOnly(string path, bool directory)
    {
        if (!OperatingSystem.IsWindows())
        {
            File.SetUnixFileMode(
                path,
                directory
                    ? UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.UserExecute
                    : UnixFileMode.UserRead | UnixFileMode.UserWrite);
        }
    }

    [DllImport("libc", EntryPoint = "geteuid")]
    private static extern long geteuid();

    private sealed class RecordingAdmission(bool enabled) : IPhase9bBudgetAdmission
    {
        public bool Enabled { get; } = enabled;

        public List<Reservation> Reservations { get; } = [];

        public Phase9bBudgetAdmissionException? Failure { get; init; }

        public Task<Phase9bBudgetReservation> ReserveAsync(
            string kind,
            Guid logicalId,
            string requestKey,
            CancellationToken cancellationToken)
        {
            var replayed = Reservations.Any(item => item.Kind == kind && item.LogicalId == logicalId);
            Reservations.Add(new Reservation(kind, logicalId, requestKey));
            if (Failure is not null)
            {
                return Task.FromException<Phase9bBudgetReservation>(Failure);
            }

            return Task.FromResult(new Phase9bBudgetReservation(kind, logicalId, Guid.NewGuid().ToString("D"), replayed, 1));
        }
    }

    private sealed record Reservation(string Kind, Guid LogicalId, string RequestKey);

    private sealed class CountingHandler : HttpMessageHandler
    {
        public List<HttpRequestMessage> Requests { get; } = [];

        public int CallCount => Requests.Count;

        protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
        {
            Requests.Add(request);
            var runId = "00000000-0000-4000-8000-000000000000";
            var logicalId = "00000000-0000-4000-8000-000000000002";
            var kind = "providerRequests";
            if (request.Content is not null)
            {
                using var body = JsonDocument.Parse(await request.Content.ReadAsStringAsync(cancellationToken));
                runId = body.RootElement.GetProperty("runId").GetString()!;
                logicalId = body.RootElement.GetProperty("logicalId").GetString()!;
                kind = body.RootElement.GetProperty("kind").GetString()!;
            }
            var responseBody = JsonSerializer.Serialize(new
            {
                schemaVersion = 1,
                status = "RESERVED",
                runId,
                reservationId = "00000000-0000-4000-8000-000000000001",
                kind,
                logicalId,
                amount = 1,
                remaining = 1,
                replayed = false
            });
            return new HttpResponseMessage(HttpStatusCode.OK)
            {
                Content = new StringContent(responseBody, Encoding.UTF8, "application/json")
            };
        }
    }
}
