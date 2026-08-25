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
        string text,
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
        long nowMs)
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
            nowMs);
    }
}
