namespace Jarvis.Domain.Tasks;

public sealed class TaskEvent
{
    private TaskEvent()
    {
    }

    private TaskEvent(
        Guid id,
        Guid taskId,
        long sequence,
        string eventType,
        string payloadJson,
        long nowMs,
        Guid? deviceId,
        Guid? executionId,
        string? clientEventId)
    {
        Id = id;
        TaskId = taskId;
        Sequence = sequence;
        EventType = eventType;
        PayloadJson = payloadJson;
        CreatedAtMs = nowMs;
        DeviceId = deviceId;
        ExecutionId = executionId;
        ClientEventId = clientEventId;
    }

    public Guid Id { get; private set; }

    public Guid TaskId { get; private set; }

    public long Sequence { get; private set; }

    public string EventType { get; private set; } = string.Empty;

    public string PayloadJson { get; private set; } = "{}";

    public long CreatedAtMs { get; private set; }

    public Guid? DeviceId { get; private set; }

    public Guid? ExecutionId { get; private set; }

    public string? ClientEventId { get; private set; }

    public long Version { get; private set; }

    public static TaskEvent Create(
        Guid id,
        Guid taskId,
        long sequence,
        string eventType,
        string payloadJson,
        long nowMs,
        Guid? deviceId = null,
        Guid? executionId = null,
        string? clientEventId = null)
    {
        ArgumentOutOfRangeException.ThrowIfNegative(sequence);
        ArgumentException.ThrowIfNullOrWhiteSpace(eventType);
        ArgumentException.ThrowIfNullOrWhiteSpace(payloadJson);
        if (clientEventId is { Length: > 200 })
        {
            throw new ArgumentException("Client event id is too long.", nameof(clientEventId));
        }

        return new TaskEvent(id, taskId, sequence, eventType.Trim(), payloadJson, nowMs, deviceId, executionId, clientEventId);
    }
}
