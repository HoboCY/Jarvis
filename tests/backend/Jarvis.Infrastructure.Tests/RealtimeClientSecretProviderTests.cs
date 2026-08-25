using System.Net;
using System.Text;
using System.Text.Json;
using Jarvis.Application.Realtime;
using Jarvis.Infrastructure.Realtime;
using Microsoft.Extensions.Options;
using Xunit;

namespace Jarvis.Infrastructure.Tests;

public sealed class RealtimeClientSecretProviderTests
{
    private static readonly string[] ExpectedToolNames = ["delegate_task", "get_task_status", "cancel_task", "remember_fact"];

    [Fact]
    public async Task SendsCurrentClientSecretContractWithServerOnlyBearerAndStableSafetyMetadata()
    {
        var handler = new RecordingHandler();
        using var httpClient = new HttpClient(handler)
        {
            BaseAddress = new Uri("https://api.openai.test/")
        };
        var options = Options.Create(new OpenAiRealtimeOptions
        {
            ApiKey = "server-key-placeholder",
            BaseUrl = "https://api.openai.test/",
            RealtimeModel = "gpt-4o-realtime-preview",
            RealtimeVoice = "alloy",
            AllowedVoices = ["alloy"],
            SafetyIdentifierSalt = "test-salt",
            ClientSecretLifetimeSeconds = 600
        });
        var provider = new OpenAiRealtimeClientSecretProvider(httpClient, options);
        var userId = Guid.Parse("aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa");

        var result = await provider.CreateAsync(
            new RealtimeClientSecretProviderRequest(
                userId,
                new ContextPackage(7, "fixed safety", "", "", [], "", ""),
                SafetyIdentifier.Create(userId, "test-salt"),
                null),
            CancellationToken.None);

        Assert.Equal("ek_test_secret", result.Value);
        Assert.Equal("oai-session-1", result.ExternalSessionId);
        Assert.Equal("gpt-4o-realtime-preview", result.Model);
        Assert.Equal("alloy", result.Voice);
        Assert.Equal("Bearer server-key-placeholder", handler.Authorization);
        Assert.Equal(HttpMethod.Post, handler.Method);
        Assert.Equal("/v1/realtime/client_secrets", handler.Path);
        Assert.NotNull(handler.Body);
        using var body = JsonDocument.Parse(handler.Body!);
        var root = body.RootElement;
        Assert.Equal("created_at", root.GetProperty("expires_after").GetProperty("anchor").GetString());
        Assert.Equal(600, root.GetProperty("expires_after").GetProperty("seconds").GetInt32());
        var session = root.GetProperty("session");
        Assert.Equal("realtime", session.GetProperty("type").GetString());
        Assert.StartsWith("fixed safety", session.GetProperty("instructions").GetString(), StringComparison.Ordinal);
        Assert.Equal("auto", session.GetProperty("tool_choice").GetString());
        Assert.Equal(
            ExpectedToolNames,
            session.GetProperty("tools")
                .EnumerateArray()
                .Select(tool => tool.GetProperty("name").GetString())
                .ToArray());
        Assert.Equal("server_vad", session.GetProperty("audio").GetProperty("input").GetProperty("turn_detection").GetProperty("type").GetString());
        Assert.True(session.GetProperty("audio").GetProperty("input").GetProperty("turn_detection").GetProperty("create_response").GetBoolean());
        Assert.True(session.GetProperty("audio").GetProperty("input").GetProperty("turn_detection").GetProperty("interrupt_response").GetBoolean());
        Assert.Equal("alloy", session.GetProperty("audio").GetProperty("output").GetProperty("voice").GetString());
        var safety = session.GetProperty("tracing").GetProperty("metadata").GetProperty("safety_identifier").GetString();
        Assert.NotNull(safety);
        Assert.InRange(safety!.Length, 1, 64);
        Assert.DoesNotContain(userId.ToString("D"), safety, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain("server-key-placeholder", handler.Body, StringComparison.Ordinal);
    }

    private sealed class RecordingHandler : HttpMessageHandler
    {
        public string? Authorization { get; private set; }

        public HttpMethod? Method { get; private set; }

        public string? Path { get; private set; }

        public string? Body { get; private set; }

        protected override async Task<HttpResponseMessage> SendAsync(
            HttpRequestMessage request,
            CancellationToken cancellationToken)
        {
            Authorization = request.Headers.Authorization?.ToString();
            Method = request.Method;
            Path = request.RequestUri?.PathAndQuery;
            Body = await request.Content!.ReadAsStringAsync(cancellationToken);
            return new HttpResponseMessage(HttpStatusCode.OK)
            {
                Content = new StringContent(
                    "{\"value\":\"ek_test_secret\",\"expires_at\":1900000000,\"session\":{\"id\":\"oai-session-1\",\"model\":\"gpt-4o-realtime-preview\",\"voice\":\"alloy\"}}",
                    Encoding.UTF8,
                    "application/json")
            };
        }
    }
}
