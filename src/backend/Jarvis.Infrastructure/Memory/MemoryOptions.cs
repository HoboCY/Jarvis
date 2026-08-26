namespace Jarvis.Infrastructure.Memory;

public sealed class MemoryOptions
{
    public const string SectionName = "Memory";

    public bool AllowSensitiveFacts { get; set; }

    public bool SensitiveFactsAllowed => AllowSensitiveFacts;
}
