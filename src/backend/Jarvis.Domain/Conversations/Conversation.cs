namespace Jarvis.Domain.Conversations;

public enum ConversationStatus
{
    Active,
    Archived
}

public sealed class Conversation
{
    private Conversation()
    {
    }

    private Conversation(Guid id, Guid userId, string title, long nowMs)
    {
        Id = id;
        UserId = userId;
        Title = title;
        Status = ConversationStatus.Active;
        LastActivityAtMs = nowMs;
        CreatedAtMs = nowMs;
    }

    public Guid Id { get; private set; }

    public Guid UserId { get; private set; }

    public string Title { get; private set; } = string.Empty;

    public ConversationStatus Status { get; private set; }

    public Guid? CurrentSummaryId { get; private set; }

    public long LastActivityAtMs { get; private set; }

    public long CreatedAtMs { get; private set; }

    public long Version { get; private set; }

    public static Conversation Create(Guid id, Guid userId, string title, long nowMs)
    {
        return new Conversation(id, userId, string.IsNullOrWhiteSpace(title) ? "New conversation" : title.Trim(), nowMs);
    }

    public void RecordActivity(long nowMs)
    {
        LastActivityAtMs = nowMs;
    }

    public bool SetCurrentSummary(Guid summaryId)
    {
        ArgumentOutOfRangeException.ThrowIfEqual(summaryId, Guid.Empty);
        if (CurrentSummaryId == summaryId)
        {
            return false;
        }

        CurrentSummaryId = summaryId;
        Version++;
        return true;
    }
}
