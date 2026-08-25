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

[JsonConverter(typeof(CamelCaseEnumConverter<RealtimeSessionStatusValue>))]
public enum RealtimeSessionStatusValue
{
    Created,
    Connected,
    Rotated,
    Disconnected,
    Failed
}

[JsonConverter(typeof(CamelCaseEnumConverter<RealtimeEventStatusValue>))]
public enum RealtimeEventStatusValue
{
    Partial,
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
    Guid? RealtimeSessionId,
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
    string ReplyMode = "text",
    Guid? RealtimeSessionId = null);

public sealed record TypedMessageResponse(
    Guid MessageId,
    long Sequence,
    bool Accepted);

public sealed record RealtimeClientSecretRequest(
    Guid ConversationId,
    Guid DeviceId,
    string? PreferredVoice = null);

public sealed record RealtimeClientSecretResponse(
    Guid RealtimeSessionId,
    Guid ConversationId,
    Guid DeviceId,
    string Instructions,
    string ClientSecret,
    long ExpiresAt,
    string Model,
    string Voice,
    long ContextVersion,
    long SessionRotationAt);

public sealed record RealtimeSessionConnectedRequest(string ExternalSessionId);

public sealed record RealtimeSessionEndedRequest(
    string Reason,
    RealtimeSessionStatusValue Status = RealtimeSessionStatusValue.Disconnected);

public sealed record RealtimeSessionResponse(
    Guid Id,
    Guid ConversationId,
    Guid DeviceId,
    string? ExternalSessionId,
    string Model,
    string Voice,
    long ContextVersion,
    RealtimeSessionStatusValue Status,
    long StartedAtMs,
    long? EndedAtMs,
    string? EndReason);

public sealed record RealtimeNormalizedEvent(
    string EventId,
    string? ExternalItemId,
    Guid RealtimeSessionId,
    MessageRoleValue Role,
    string Modality,
    RealtimeEventStatusValue Status,
    string? Text,
    long? OccurredAtMs = null);

public sealed record RealtimeEventsIngestRequest(
    int Version,
    IReadOnlyList<RealtimeNormalizedEvent> Events);

public sealed record RealtimeEventsIngestResponse(
    int Version,
    int Accepted,
    int Deduplicated,
    IReadOnlyList<Guid> MessageIds);

public sealed record DesktopDeviceBootstrapResponse(
    Guid DeviceId,
    string Name,
    DeviceTypeValue DeviceType,
    string Platform,
    DeviceStatusValue Status);

[JsonConverter(typeof(CamelCaseEnumConverter<TaskStatusValue>))]
public enum TaskStatusValue
{
    Queued,
    Assigned,
    Running,
    WaitingForApproval,
    WaitingForUserInput,
    CancellationRequested,
    Recovering,
    Succeeded,
    Failed,
    Cancelled
}

[JsonConverter(typeof(CamelCaseEnumConverter<WorkerKindValue>))]
public enum WorkerKindValue
{
    Internal,
    Responses,
    Codex
}

[JsonConverter(typeof(CamelCaseEnumConverter<NotificationSeverityValue>))]
public enum NotificationSeverityValue
{
    Info,
    Success,
    Warning,
    Error
}

[JsonConverter(typeof(CamelCaseEnumConverter<NotificationStatusValue>))]
public enum NotificationStatusValue
{
    Pending,
    Delivered,
    Read,
    Actioned,
    Dismissed
}

public sealed record CreateTaskRequest(
    Guid ConversationId,
    IReadOnlyList<Guid>? SourceMessageIds,
    string Goal,
    string? ExpectedOutput,
    IReadOnlyList<string>? RequiredCapabilities,
    Guid? PreferredDeviceId = null,
    IReadOnlyList<string>? AttachmentRefs = null);

public sealed record TaskResponse(
    Guid Id,
    Guid ConversationId,
    Guid? CreatedByMessageId,
    string Goal,
    string? ExpectedOutput,
    IReadOnlyList<string> RequiredCapabilities,
    IReadOnlyList<string> AttachmentRefs,
    Guid? PreferredDeviceId,
    Guid? AssignedDeviceId,
    WorkerKindValue WorkerKind,
    TaskStatusValue Status,
    int Priority,
    int Attempt,
    string? ProgressSummary,
    string? ResultSummary,
    string? ResultPayloadJson,
    string? ErrorCode,
    string? ErrorMessage,
    long EntityVersion,
    long CreatedAtMs,
    long? StartedAtMs,
    long? CompletedAtMs);

public sealed record TaskAcceptedResponse(
    bool Accepted,
    Guid TaskId,
    TaskStatusValue Status,
    WorkerKindValue WorkerKind,
    string Message = "任务已进入后台队列");

public sealed record TaskListResponse(
    IReadOnlyList<TaskResponse> Items,
    string? NextCursor = null);

public sealed record TaskCancelResponse(
    Guid TaskId,
    bool Accepted,
    TaskStatusValue Status);

public sealed record NotificationResponse(
    Guid Id,
    Guid? ConversationId,
    Guid? TaskId,
    string Type,
    NotificationSeverityValue Severity,
    string Title,
    string Body,
    string ActionsJson,
    string DedupKey,
    NotificationStatusValue Status,
    long EntityVersion,
    long CreatedAtMs,
    long? DeliveredAtMs,
    long? ReadAtMs,
    long? ActionedAtMs);

public sealed record NotificationListResponse(IReadOnlyList<NotificationResponse> Items);

[JsonConverter(typeof(CamelCaseEnumConverter<DeviceTypeValue>))]
public enum DeviceTypeValue
{
    Desktop,
    Mobile,
    Server
}

[JsonConverter(typeof(CamelCaseEnumConverter<DeviceStatusValue>))]
public enum DeviceStatusValue
{
    Online,
    Offline,
    Disabled
}

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
