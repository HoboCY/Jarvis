using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Text.Json;
using System.Text.Json.Serialization;
using Jarvis.Application.Realtime;
using Microsoft.Extensions.Options;

namespace Jarvis.Infrastructure.Realtime;

public sealed class OpenAiRealtimeClientSecretProvider(
    HttpClient httpClient,
    IOptions<OpenAiRealtimeOptions> options) : IRealtimeClientSecretProvider
{
    private static readonly JsonSerializerOptions JsonOptions = new(JsonSerializerDefaults.Web)
    {
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull
    };

    public async Task<RealtimeClientSecretProviderResponse> CreateAsync(
        RealtimeClientSecretProviderRequest request,
        CancellationToken cancellationToken)
    {
        var settings = options.Value;
        var voice = ResolveVoice(settings, request.PreferredVoice);
        var body = new ClientSecretRequest(
            new ExpiresAfter("created_at", settings.ClientSecretLifetimeSeconds),
            new RealtimeSessionRequest(
                "realtime",
                settings.RealtimeModel,
                request.Context.AsPrompt(),
                RealtimeTools.All,
                "auto",
                new AudioOptions(
                    new InputAudioOptions(
                        new TranscriptionOptions("gpt-4o-mini-transcribe"),
                        new TurnDetectionOptions("server_vad", true, true)),
                    new OutputAudioOptions(voice)),
                new TracingOptions(
                    "jarvis-realtime",
                    null,
                    new Dictionary<string, string>
                    {
                        ["safety_identifier"] = request.SafetyIdentifier
                    })));

        using var httpRequest = new HttpRequestMessage(HttpMethod.Post, "/v1/realtime/client_secrets")
        {
            Content = JsonContent.Create(body, options: JsonOptions)
        };
        httpRequest.Headers.Authorization = new AuthenticationHeaderValue("Bearer", settings.ApiKey);
        using var response = await httpClient.SendAsync(httpRequest, cancellationToken);
        if (!response.IsSuccessStatusCode)
        {
            throw new HttpRequestException($"OpenAI realtime client secret request failed with HTTP {(int)response.StatusCode}.");
        }

        var payload = await response.Content.ReadFromJsonAsync<ClientSecretResponse>(JsonOptions, cancellationToken)
            ?? throw new InvalidOperationException("OpenAI returned an empty realtime client secret response.");
        if (string.IsNullOrWhiteSpace(payload.Value)
            || string.IsNullOrWhiteSpace(payload.Session?.Id)
            || payload.ExpiresAt is null)
        {
            throw new InvalidOperationException("OpenAI returned an incomplete realtime client secret response.");
        }

        return new(
            payload.Value,
            ToUnixMilliseconds(payload.ExpiresAt.Value),
            payload.Session.Id,
            payload.Session.Model ?? settings.RealtimeModel,
            payload.Session.Voice ?? voice);
    }

    private static string ResolveVoice(OpenAiRealtimeOptions settings, string? preferredVoice)
    {
        var voice = string.IsNullOrWhiteSpace(preferredVoice) ? settings.RealtimeVoice : preferredVoice.Trim();
        if (settings.AllowedVoices.Length == 0
            || !settings.AllowedVoices.Contains(voice, StringComparer.OrdinalIgnoreCase))
        {
            throw new ArgumentException("The requested realtime voice is not allowed.", nameof(preferredVoice));
        }

        return voice;
    }

    private static long ToUnixMilliseconds(JsonElement value)
    {
        if (value.ValueKind == JsonValueKind.Number && value.TryGetInt64(out var number))
        {
            return number < 100_000_000_000L ? checked(number * 1_000L) : number;
        }

        if (value.ValueKind == JsonValueKind.String
            && DateTimeOffset.TryParse(value.GetString(), out var date))
        {
            return date.ToUnixTimeMilliseconds();
        }

        throw new InvalidOperationException("OpenAI returned an invalid expires_at value.");
    }

    private sealed record ClientSecretRequest(
        [property: JsonPropertyName("expires_after")] ExpiresAfter ExpiresAfter,
        [property: JsonPropertyName("session")] RealtimeSessionRequest Session);

    private sealed record ExpiresAfter(
        [property: JsonPropertyName("anchor")] string Anchor,
        [property: JsonPropertyName("seconds")] int Seconds);

    private sealed record RealtimeSessionRequest(
        [property: JsonPropertyName("type")] string Type,
        [property: JsonPropertyName("model")] string Model,
        [property: JsonPropertyName("instructions")] string Instructions,
        [property: JsonPropertyName("tools")] IReadOnlyList<RealtimeTool> Tools,
        [property: JsonPropertyName("tool_choice")] string ToolChoice,
        [property: JsonPropertyName("audio")] AudioOptions Audio,
        [property: JsonPropertyName("tracing")] TracingOptions Tracing);

    private sealed record AudioOptions(
        [property: JsonPropertyName("input")] InputAudioOptions Input,
        [property: JsonPropertyName("output")] OutputAudioOptions Output);

    private sealed record InputAudioOptions(
        [property: JsonPropertyName("transcription")] TranscriptionOptions Transcription,
        [property: JsonPropertyName("turn_detection")] TurnDetectionOptions TurnDetection);

    private sealed record TranscriptionOptions(
        [property: JsonPropertyName("model")] string Model);

    private sealed record TurnDetectionOptions(
        [property: JsonPropertyName("type")] string Type,
        [property: JsonPropertyName("create_response")] bool CreateResponse,
        [property: JsonPropertyName("interrupt_response")] bool InterruptResponse);

    private sealed record OutputAudioOptions(
        [property: JsonPropertyName("voice")] string Voice);

    private sealed record TracingOptions(
        [property: JsonPropertyName("workflow_name")] string WorkflowName,
        [property: JsonPropertyName("group_id")] string? GroupId,
        [property: JsonPropertyName("metadata")] IReadOnlyDictionary<string, string> Metadata);

    private sealed record RealtimeTool(
        [property: JsonPropertyName("type")] string Type,
        [property: JsonPropertyName("name")] string Name,
        [property: JsonPropertyName("description")] string Description,
        [property: JsonPropertyName("parameters")] object Parameters);

    private static class RealtimeTools
    {
        private static readonly object DelegateTaskParameters = new
        {
            type = "object",
            properties = new
            {
                goal = new { type = "string" },
                expectedOutput = new { type = new[] { "string", "null" } },
                requiredCapabilities = new { type = "array", items = new { type = "string" } },
                preferredDeviceId = new { type = new[] { "string", "null" }, format = "uuid" },
                sourceMessageIds = new { type = "array", items = new { type = "string", format = "uuid" } },
                attachmentRefs = new { type = "array", items = new { type = "string" } }
            },
            required = new[]
            {
                "goal",
                "expectedOutput",
                "requiredCapabilities",
                "preferredDeviceId",
                "sourceMessageIds",
                "attachmentRefs"
            },
            additionalProperties = false
        };

        private static readonly object TaskIdParameters = new
        {
            type = "object",
            properties = new
            {
                taskId = new { type = "string", format = "uuid" }
            },
            required = new[] { "taskId" },
            additionalProperties = false
        };

        private static readonly object RememberFactParameters = new
        {
            type = "object",
            properties = new
            {
                fact = new { type = "string" }
            },
            required = new[] { "fact" },
            additionalProperties = false
        };

        public static IReadOnlyList<RealtimeTool> All =
        [
            new("function", "delegate_task", "Queue work in the backend; never claim it completed.", DelegateTaskParameters),
            new("function", "get_task_status", "Read the status of an existing backend task.", TaskIdParameters),
            new("function", "cancel_task", "Request cancellation of an existing backend task.", TaskIdParameters),
            new("function", "remember_fact", "Ask the backend to validate a memory fact; unavailable in Phase 2.", RememberFactParameters)
        ];
    }

    private sealed record ClientSecretResponse(
        [property: JsonPropertyName("value")] string? Value,
        [property: JsonPropertyName("expires_at")] JsonElement? ExpiresAt,
        [property: JsonPropertyName("session")] SessionResponse? Session);

    private sealed record SessionResponse(
        [property: JsonPropertyName("id")] string? Id,
        [property: JsonPropertyName("model")] string? Model,
        [property: JsonPropertyName("voice")] string? Voice);
}
