namespace Jarvis.Infrastructure.Responses;

public sealed class ResponsesOptions
{
    public const string SectionName = "Responses";

    public string Provider { get; set; } = "OpenAI";

    public string Model { get; set; } = string.Empty;

    public string SummarizerModel { get; set; } = string.Empty;

    public int TimeoutSeconds { get; set; } = 60;

    public int MaxTransientRetries { get; set; } = 2;

    public int PollingIntervalMs { get; set; } = 250;
}

public sealed class DeepSeekOptions
{
    public const string SectionName = "DeepSeek";

    public string ApiKey { get; set; } = string.Empty;

    public string BaseUrl { get; set; } = string.Empty;
}
