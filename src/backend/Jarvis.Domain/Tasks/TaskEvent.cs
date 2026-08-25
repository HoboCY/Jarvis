namespace Jarvis.Domain.Tasks;

public sealed class TaskEvent
{
    private TaskEvent()
    {
    }

    private TaskEvent(Guid id, Guid taskId, long sequence, string eventType, string payloadJson, long nowMs)
    {
        Id = id;
        TaskId = taskId;
        Sequence = sequence;
        EventType = eventType;
        PayloadJson = payloadJson;
        CreatedAtMs = nowMs;
    }

    public Guid Id { get; private set; }

    public Guid TaskId { get; private set; }

    public long Sequence { get; private set; }

    public string EventType { get; private set; } = string.Empty;

    public string PayloadJson { get; private set; } = "{}";

    public long CreatedAtMs { get; private set; }

    public long Version { get; private set; }

    public static TaskEvent Create(
        Guid id,
        Guid taskId,
        long sequence,
        string eventType,
        string payloadJson,
        long nowMs)
    {
        ArgumentOutOfRangeException.ThrowIfNegative(sequence);
        ArgumentException.ThrowIfNullOrWhiteSpace(eventType);
        ArgumentException.ThrowIfNullOrWhiteSpace(payloadJson);
        return new TaskEvent(id, taskId, sequence, eventType.Trim(), payloadJson, nowMs);
    }
}
