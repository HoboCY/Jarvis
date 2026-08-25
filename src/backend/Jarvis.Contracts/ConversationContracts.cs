using System.Text.Json;
using System.Text.Json.Serialization;

namespace Jarvis.Contracts;

[JsonConverter(typeof(CamelCaseEnumConverter<ConversationStatusValue>))]
public enum ConversationStatusValue
{
    Active,
    Archived
}

[JsonConverter(typeof(CamelCaseEnumConverter<MessageRoleValue>))]
public enum MessageRoleValue
{
    User,
    Assistant,
    Tool,
    System
}

[JsonConverter(typeof(CamelCaseEnumConverter<MessageInputModalityValue>))]
public enum MessageInputModalityValue
{
    Voice,
    TypedText,
    Image,
    Tool
}

[JsonConverter(typeof(CamelCaseEnumConverter<MessageOutputModalityValue>))]
public enum MessageOutputModalityValue
{
    Audio,
    Text,
    AudioWithTranscript
}

[JsonConverter(typeof(CamelCaseEnumConverter<MessageStatusValue>))]
public enum MessageStatusValue
{
    Pending,
    Streaming,
    Completed,
    Interrupted,
    Failed
}

public sealed record CreateConversationRequest(string? Title);

public sealed record ConversationResponse(
    Guid Id,
    string Title,
    ConversationStatusValue Status,
    long LastActivityAtMs,
    long CreatedAtMs,
    IReadOnlyList<MessageResponse> Messages,
    int MessageCount);

public sealed record MessageResponse(
    Guid Id,
    Guid ConversationId,
    MessageRoleValue Role,
    MessageInputModalityValue? InputModality,
    MessageOutputModalityValue? OutputModality,
    string? Text,
    MessageStatusValue Status,
    string? ExternalItemId,
    string? ClientRequestId,
    long Sequence,
    long StartedAtMs,
    long? CompletedAtMs);

public sealed record MessagePageResponse(
    IReadOnlyList<MessageResponse> Items,
    string? NextCursor);

public sealed record TypedMessageRequest(
    string ClientRequestId,
    string Text,
    string ReplyMode = "text");

public sealed record TypedMessageResponse(
    Guid MessageId,
    long Sequence,
    bool Accepted);

public sealed record OutboxEventEnvelope(
    Guid EventId,
    long OccurredAt,
    string Type,
    object Payload);

public sealed class CamelCaseEnumConverter<TEnum> : JsonConverter<TEnum>
    where TEnum : struct, Enum
{
    public override TEnum Read(
        ref Utf8JsonReader reader,
        Type typeToConvert,
        JsonSerializerOptions options)
    {
        var value = reader.GetString();
        foreach (var candidate in Enum.GetValues<TEnum>())
        {
            if (string.Equals(
                    JsonNamingPolicy.CamelCase.ConvertName(candidate.ToString()),
                    value,
                    StringComparison.OrdinalIgnoreCase))
            {
                return candidate;
            }
        }

        throw new JsonException($"Unknown {typeof(TEnum).Name} value '{value}'.");
    }

    public override void Write(
        Utf8JsonWriter writer,
        TEnum value,
        JsonSerializerOptions options)
    {
        writer.WriteStringValue(JsonNamingPolicy.CamelCase.ConvertName(value.ToString()));
    }
}
