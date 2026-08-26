namespace Jarvis.Domain.Conversations;

public sealed class ConversationSummary
{
    private ConversationSummary()
    {
    }

    private ConversationSummary(
        Guid id,
        Guid conversationId,
        long fromSequence,
        long toSequence,
        string summary,
        string model,
        long createdAtMs)
    {
        Id = id;
        ConversationId = conversationId;
        FromSequence = fromSequence;
        ToSequence = toSequence;
        Summary = summary;
        Model = model;
        CreatedAtMs = createdAtMs;
    }

    public Guid Id { get; private set; }

    public Guid ConversationId { get; private set; }

    public long FromSequence { get; private set; }

    public long ToSequence { get; private set; }

    public string Summary { get; private set; } = string.Empty;

    public string Model { get; private set; } = string.Empty;

    public long CreatedAtMs { get; private set; }

    public long Version { get; private set; }

    public static ConversationSummary Create(
        Guid id,
        Guid conversationId,
        long fromSequence,
        long toSequence,
        string summary,
        string model,
        long createdAtMs)
    {
        ArgumentOutOfRangeException.ThrowIfEqual(id, Guid.Empty);
        ArgumentOutOfRangeException.ThrowIfEqual(conversationId, Guid.Empty);
        ArgumentOutOfRangeException.ThrowIfNegative(fromSequence);
        ArgumentOutOfRangeException.ThrowIfNegative(toSequence);
        if (fromSequence > toSequence)
        {
            throw new ArgumentException("A summary range must be continuous and ordered.", nameof(fromSequence));
        }

        ArgumentException.ThrowIfNullOrWhiteSpace(summary);
        ArgumentException.ThrowIfNullOrWhiteSpace(model);
        ArgumentOutOfRangeException.ThrowIfNegative(createdAtMs);
        return new ConversationSummary(
            id,
            conversationId,
            fromSequence,
            toSequence,
            summary.Trim(),
            model.Trim(),
            createdAtMs);
    }
}
