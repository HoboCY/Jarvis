namespace Jarvis.Infrastructure.Realtime;

public sealed class OpenAiRealtimeOptions
{
    public const string SectionName = "OpenAI";
    public const string BearerAuthentication = "Bearer";
    public const string ApiKeyAuthentication = "ApiKey";

    public string ApiKey { get; set; } = string.Empty;

    public string AuthenticationMode { get; set; } = BearerAuthentication;

    public string BaseUrl { get; set; } = string.Empty;

    public string RealtimeModel { get; set; } = string.Empty;

    public string RealtimeVoice { get; set; } = string.Empty;

    public string SafetyIdentifierSalt { get; set; } = string.Empty;

    public int ClientSecretLifetimeSeconds { get; set; } = 600;

    public string[] AllowedVoices { get; set; } = [];
}
