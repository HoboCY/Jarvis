namespace Jarvis.Infrastructure.Outbox;

public sealed class OutboxOptions
{
    public const string SectionName = "Outbox";

    public bool Enabled { get; set; } = true;

    public int PollingIntervalMs { get; set; } = 1_000;

    public int BatchSize { get; set; } = 20;

    public int MaxBackoffMs { get; set; } = 60_000;

    public int LeaseDurationMs { get; set; } = 30_000;
}
