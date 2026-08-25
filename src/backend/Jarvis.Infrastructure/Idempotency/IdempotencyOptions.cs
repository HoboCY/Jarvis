namespace Jarvis.Infrastructure.Idempotency;

public sealed class IdempotencyOptions
{
    public const string SectionName = "Idempotency";

    public long RetentionMs { get; set; } = 24L * 60L * 60L * 1_000L;
}
