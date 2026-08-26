namespace Jarvis.Infrastructure.Observability;

public sealed class ObservabilityOptions
{
    public const string SectionName = "Observability";

    public string ServiceName { get; set; } = "jarvis";

    public string OtlpEndpoint { get; set; } = string.Empty;

    public bool Enabled { get; set; } = true;

    public bool IncludeUserContent { get; set; }

    public int MaxLogValueLength { get; set; } = 2_000;
}
