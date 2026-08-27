namespace Jarvis.Domain.Tasks;

public enum TaskUserInputRequestStatus
{
    Pending,
    Answered,
    Cleared,
    Expired
}

/// <summary>
/// Durable state for one Codex user-input request. The answer payload is retained only
/// here so a Device Node can recover after a process restart; events and outbox messages
/// must contain identifiers and status only.
/// </summary>
public sealed class TaskUserInputRequest
{
    private TaskUserInputRequest()
    {
    }

    private TaskUserInputRequest(
        Guid id,
        Guid taskId,
        Guid executionId,
        Guid deviceId,
        string requestId,
        bool requestIdIsString,
        string itemId,
        string threadId,
        string turnId,
        string questionsJson,
        long createdAtMs,
        long? expiresAtMs)
    {
        Id = id;
        TaskId = taskId;
        ExecutionId = executionId;
        DeviceId = deviceId;
        RequestId = requestId;
        RequestIdIsString = requestIdIsString;
        ItemId = itemId;
        ThreadId = threadId;
        TurnId = turnId;
        QuestionsJson = questionsJson;
        Status = TaskUserInputRequestStatus.Pending;
        CreatedAtMs = createdAtMs;
        ExpiresAtMs = expiresAtMs;
    }

    public Guid Id { get; private set; }

    public Guid TaskId { get; private set; }

    public Guid ExecutionId { get; private set; }

    public Guid DeviceId { get; private set; }

    public string RequestId { get; private set; } = string.Empty;

    public bool RequestIdIsString { get; private set; }

    public string ItemId { get; private set; } = string.Empty;

    public string ThreadId { get; private set; } = string.Empty;

    public string TurnId { get; private set; } = string.Empty;

    public string QuestionsJson { get; private set; } = "[]";

    public string? AnswersJson { get; private set; }

    public TaskUserInputRequestStatus Status { get; private set; }

    public long CreatedAtMs { get; private set; }

    public long? AnsweredAtMs { get; private set; }

    public long? ClearedAtMs { get; private set; }

    public long? ExpiresAtMs { get; private set; }

    public long Version { get; private set; }

    public static TaskUserInputRequest Create(
        Guid id,
        Guid taskId,
        Guid executionId,
        Guid deviceId,
        string requestId,
        bool requestIdIsString,
        string itemId,
        string threadId,
        string turnId,
        string questionsJson,
        long createdAtMs,
        long? expiresAtMs)
    {
        ArgumentOutOfRangeException.ThrowIfEqual(id, Guid.Empty);
        ArgumentOutOfRangeException.ThrowIfEqual(taskId, Guid.Empty);
        ArgumentOutOfRangeException.ThrowIfEqual(executionId, Guid.Empty);
        ArgumentOutOfRangeException.ThrowIfEqual(deviceId, Guid.Empty);
        ArgumentException.ThrowIfNullOrWhiteSpace(requestId);
        ArgumentException.ThrowIfNullOrWhiteSpace(itemId);
        ArgumentException.ThrowIfNullOrWhiteSpace(threadId);
        ArgumentException.ThrowIfNullOrWhiteSpace(turnId);
        ArgumentException.ThrowIfNullOrWhiteSpace(questionsJson);
        ArgumentOutOfRangeException.ThrowIfNegative(createdAtMs);
        if (expiresAtMs is <= 0 || expiresAtMs <= createdAtMs)
        {
            throw new ArgumentOutOfRangeException(nameof(expiresAtMs));
        }

        return new TaskUserInputRequest(
            id,
            taskId,
            executionId,
            deviceId,
            requestId.Trim(),
            requestIdIsString,
            itemId.Trim(),
            threadId.Trim(),
            turnId.Trim(),
            questionsJson,
            createdAtMs,
            expiresAtMs);
    }

    public static TaskUserInputRequest Create(
        Guid id,
        Guid taskId,
        Guid executionId,
        Guid deviceId,
        string requestId,
        string itemId,
        string threadId,
        string turnId,
        string questionsJson,
        long createdAtMs,
        long? expiresAtMs) => Create(
            id,
            taskId,
            executionId,
            deviceId,
            requestId,
            true,
            itemId,
            threadId,
            turnId,
            questionsJson,
            createdAtMs,
            expiresAtMs);

    public bool Answer(string answersJson, long nowMs)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(answersJson);
        ArgumentOutOfRangeException.ThrowIfNegative(nowMs);
        if (Status == TaskUserInputRequestStatus.Answered)
        {
            return string.Equals(AnswersJson, answersJson, StringComparison.Ordinal);
        }

        if (Status != TaskUserInputRequestStatus.Pending)
        {
            return false;
        }

        Status = TaskUserInputRequestStatus.Answered;
        AnswersJson = answersJson;
        AnsweredAtMs = nowMs;
        Version++;
        return true;
    }

    public bool Clear(long nowMs)
    {
        ArgumentOutOfRangeException.ThrowIfNegative(nowMs);
        if (Status != TaskUserInputRequestStatus.Pending)
        {
            return false;
        }

        Status = TaskUserInputRequestStatus.Cleared;
        ClearedAtMs = nowMs;
        Version++;
        return true;
    }

    public bool Expire(long nowMs)
    {
        ArgumentOutOfRangeException.ThrowIfNegative(nowMs);
        if (Status != TaskUserInputRequestStatus.Pending
            || ExpiresAtMs is not long expiresAtMs
            || expiresAtMs > nowMs)
        {
            return false;
        }

        Status = TaskUserInputRequestStatus.Expired;
        ClearedAtMs = nowMs;
        Version++;
        return true;
    }
}
