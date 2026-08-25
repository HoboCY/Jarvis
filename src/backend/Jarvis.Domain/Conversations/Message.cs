namespace Jarvis.Domain.Conversations;

public enum MessageRole
{
    User,
    Assistant,
    Tool,
    System
}

public enum MessageInputModality
{
    Voice,
    TypedText,
    Image,
    Tool
}

public enum MessageOutputModality
{
    Audio,
    Text,
    AudioWithTranscript
}

public enum MessageStatus
{
    Pending,
    Streaming,
    Completed,
    Interrupted,
    Failed
}

public sealed class Message
{
    private Message()
    {
    }

    private Message(
        Guid id,
        Guid conversationId,
        MessageRole role,
        MessageInputModality? inputModality,
        MessageOutputModality? outputModality,
        string? text,
        string? externalItemId,
        string? clientRequestId,
        long sequence,
        long nowMs)
    {
        Id = id;
        ConversationId = conversationId;
        Role = role;
        InputModality = inputModality;
        OutputModality = outputModality;
        Text = text;
        Status = MessageStatus.Completed;
        ExternalItemId = externalItemId;
        ClientRequestId = clientRequestId;
        Sequence = sequence;
        StartedAtMs = nowMs;
        CompletedAtMs = nowMs;
        Version = 1;
    }

    public Guid Id { get; private set; }

    public Guid ConversationId { get; private set; }

    public Guid? RealtimeSessionId { get; private set; }

    public MessageRole Role { get; private set; }

    public MessageInputModality? InputModality { get; private set; }

    public MessageOutputModality? OutputModality { get; private set; }

    public string? Text { get; private set; }

    public MessageStatus Status { get; private set; }

    public string? ExternalItemId { get; private set; }

    public string? ClientRequestId { get; private set; }

    public long Sequence { get; private set; }

    public long StartedAtMs { get; private set; }

    public long? CompletedAtMs { get; private set; }

    public string MetadataJson { get; private set; } = "{}";

    public long Version { get; private set; }

    public static Message CreateTypedUserMessage(
        Guid id,
        Guid conversationId,
        string text,
        string clientRequestId,
        long sequence,
        long nowMs,
        Guid? realtimeSessionId = null)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(text);
        ArgumentException.ThrowIfNullOrWhiteSpace(clientRequestId);

        return new Message(
            id,
            conversationId,
            MessageRole.User,
            MessageInputModality.TypedText,
            null,
            text.Trim(),
            null,
            clientRequestId.Trim(),
            sequence,
            nowMs)
        {
            RealtimeSessionId = realtimeSessionId
        };
    }

    public static Message CreateRealtimeMessage(
        Guid id,
        Guid conversationId,
        Guid realtimeSessionId,
        MessageRole role,
        MessageInputModality? inputModality,
        MessageOutputModality? outputModality,
        MessageStatus status,
        string? text,
        string externalItemId,
        long sequence,
        long nowMs)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(externalItemId);
        if (role is not (MessageRole.User or MessageRole.Assistant))
        {
            throw new ArgumentOutOfRangeException(nameof(role));
        }

        return new Message(
            id,
            conversationId,
            role,
            inputModality,
            outputModality,
            text,
            externalItemId.Trim(),
            null,
            sequence,
            nowMs)
        {
            RealtimeSessionId = realtimeSessionId,
            Status = status,
            CompletedAtMs = status is MessageStatus.Completed or MessageStatus.Interrupted or MessageStatus.Failed
                ? nowMs
                : null
        };
    }

    public bool ApplyRealtimeUpdate(
        MessageStatus status,
        string? text,
        MessageInputModality? inputModality,
        MessageOutputModality? outputModality,
        long nowMs)
    {
        if (Status is MessageStatus.Completed or MessageStatus.Interrupted or MessageStatus.Failed)
        {
            if (Status != status && status is not (MessageStatus.Completed or MessageStatus.Interrupted or MessageStatus.Failed))
            {
                throw new InvalidOperationException("A terminal message cannot return to a streaming state.");
            }

            if (Status != status && status is (MessageStatus.Completed or MessageStatus.Interrupted or MessageStatus.Failed))
            {
                throw new InvalidOperationException("A terminal message cannot change terminal status.");
            }

            var terminalChanged = false;
            if (text is not null && !string.Equals(Text, text, StringComparison.Ordinal))
            {
                Text = text;
                terminalChanged = true;
            }

            if (inputModality is not null && InputModality != inputModality)
            {
                InputModality = inputModality;
                terminalChanged = true;
            }

            if (outputModality is not null && OutputModality != outputModality)
            {
                OutputModality = outputModality;
                terminalChanged = true;
            }

            if (terminalChanged)
            {
                Version++;
            }

            return terminalChanged;
        }

        var changed = Status != status
            || (text is not null && !string.Equals(Text, text, StringComparison.Ordinal))
            || (inputModality is not null && InputModality != inputModality)
            || (outputModality is not null && OutputModality != outputModality);
        Status = status;
        if (text is not null)
        {
            Text = text;
        }

        InputModality = inputModality ?? InputModality;
        OutputModality = outputModality ?? OutputModality;
        if (status is MessageStatus.Completed or MessageStatus.Interrupted or MessageStatus.Failed)
        {
            CompletedAtMs = nowMs;
        }

        if (changed)
        {
            Version++;
        }

        return changed;
    }
}
