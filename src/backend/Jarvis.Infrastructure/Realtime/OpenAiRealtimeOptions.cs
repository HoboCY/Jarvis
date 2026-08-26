namespace Jarvis.Infrastructure.Realtime;

public sealed class OpenAiRealtimeOptions
{
    public const string SectionName = "OpenAI";

    public string ApiKey { get; set; } = string.Empty;

    public string BaseUrl { get; set; } = string.Empty;

    public string RealtimeModel { get; set; } = string.Empty;

    public string RealtimeVoice { get; set; } = string.Empty;

    public string SafetyIdentifierSalt { get; set; } = string.Empty;

    public int ClientSecretLifetimeSeconds { get; set; } = 600;

    public string[] AllowedVoices { get; set; } = [];

    public string ResponsesModel { get; set; } = string.Empty;

    public string SummarizerModel { get; set; } = string.Empty;

    public int ResponsesTimeoutSeconds { get; set; } = 60;

    public int ResponsesMaxTransientRetries { get; set; } = 2;

    public int ResponsesPollingIntervalMs { get; set; } = 250;
}
