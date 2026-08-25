namespace Jarvis.Infrastructure.Tasks;

public sealed class FakeDelayOptions
{
    public const string SectionName = "FakeWorker";
    public const int MaxDelayMs = 60_000;
    public const long LeaseSafetyMarginMs = 5_000;
    public const long LeaseDurationMs = MaxDelayMs + LeaseSafetyMarginMs + 1;

    public bool Enabled { get; set; } = true;

    public int DelayMs { get; set; } = 50;

    public int PollingIntervalMs { get; set; } = 100;

    public int LeaseRenewalIntervalMs { get; set; } = 5_000;

    public string? WorkerDeviceId { get; set; }

    public static bool IsValidWorkerDeviceId(string? value) =>
        string.IsNullOrWhiteSpace(value)
        || Guid.TryParse(value, out var workerDeviceId) && workerDeviceId != Guid.Empty;
}
