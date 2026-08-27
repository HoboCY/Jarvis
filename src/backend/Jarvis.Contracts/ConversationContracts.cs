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
    IReadOnlyList<string>? AttachmentRefs = null,
    CapabilityEnvelopeContract? CapabilityEnvelope = null);

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
    long? CompletedAtMs,
    TaskExecutionResponse? Execution = null,
    IReadOnlyList<ArtifactManifestEntry>? Artifacts = null,
    CapabilityEnvelopeContract? CapabilityEnvelope = null,
    TaskUserInputResponse? PendingUserInput = null);

[JsonConverter(typeof(CamelCaseEnumConverter<TaskExecutionStatusValue>))]
public enum TaskExecutionStatusValue
{
    Assigned,
    Running,
    WaitingForApproval,
    Recovering,
    Succeeded,
    Failed,
    Cancelled,
    WaitingForUserInput
}

public sealed record TaskExecutionResponse(
    Guid Id,
    Guid TaskId,
    Guid? DeviceId,
    WorkerKindValue WorkerKind,
    string? ExternalExecutionId,
    string? CodexThreadId,
    string? CodexTurnId,
    TaskExecutionStatusValue Status,
    string MetadataJson,
    string? ResultPayloadJson,
    IReadOnlyList<ArtifactManifestEntry> Artifacts,
    long StartedAtMs,
    long? EndedAtMs,
    long EntityVersion,
    long? CodexTurnStartRequestedAtMs = null);

public sealed record ArtifactManifestEntry(
    string Path,
    long Size,
    string Sha256,
    string ContentType = "application/octet-stream");

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

[JsonConverter(typeof(CamelCaseEnumConverter<ApprovalKindValue>))]
public enum ApprovalKindValue
{
    Command,
    FileWrite,
    Permission,
    ExternalWrite
}

[JsonConverter(typeof(CamelCaseEnumConverter<ApprovalScopeValue>))]
public enum ApprovalScopeValue
{
    Once,
    TaskSession
}

[JsonConverter(typeof(CamelCaseEnumConverter<ApprovalStatusValue>))]
public enum ApprovalStatusValue
{
    Pending,
    Approved,
    Denied,
    Expired,
    Cancelled
}

[JsonConverter(typeof(CamelCaseEnumConverter<ApprovalDecisionValue>))]
public enum ApprovalDecisionValue
{
    Approve,
    Deny
}

public sealed record ApprovalResponse(
    Guid Id,
    Guid TaskId,
    Guid? ExecutionId,
    Guid DeviceId,
    ApprovalKindValue Kind,
    string Reason,
    ApprovalStatusValue Status,
    ApprovalScopeValue? Scope,
    string? RequestId,
    Guid? DecidedByDeviceId,
    long CreatedAtMs,
    long? DecidedAtMs,
    long? ExpiresAtMs,
    long EntityVersion);

public sealed record ApprovalListResponse(IReadOnlyList<ApprovalResponse> Items);

public sealed record ApprovalDecisionRequest(
    ApprovalDecisionValue Decision,
    ApprovalScopeValue Scope,
    string ClientRequestId);

public sealed record DeviceApprovalRequest(
    Guid ExecutionId,
    ApprovalKindValue Kind,
    string Reason,
    string RequestedActionJson,
    ApprovalScopeValue? Scope = null,
    string? RequestId = null,
    long? ExpiresAtMs = null);

public sealed record DeviceApprovalResponse(Guid ApprovalId, ApprovalStatusValue Status);

public sealed record DeviceRegistrationRequest(
    string Name,
    DeviceTypeValue DeviceType,
    string Platform,
    IReadOnlyList<string>? Capabilities,
    IReadOnlyList<string>? AllowedRoots = null);

public sealed record DeviceRegistrationResponse(
    Guid DeviceId,
    Guid UserId,
    string Name,
    DeviceTypeValue DeviceType,
    string Platform,
    IReadOnlyList<string> Capabilities,
    DeviceStatusValue Status,
    string DeviceCredential);

public sealed record DeviceHeartbeatRequest(IReadOnlyList<string>? Capabilities, IReadOnlyList<string>? AllowedRoots = null);

public sealed record DeviceHeartbeatResponse(
    Guid DeviceId,
    DeviceStatusValue Status,
    long LastSeenAtMs,
    IReadOnlyList<string> Capabilities,
    long EntityVersion);

public sealed record CapabilityEnvelopeContract(
    bool ReadFiles = false,
    bool WriteFiles = false,
    bool RunCommands = false,
    bool Network = false,
    IReadOnlyList<string>? AllowedRoots = null);

public sealed record DeviceTaskClaimRequest(
    string? LeaseOwner = null,
    CapabilityEnvelopeContract? CapabilityEnvelope = null);

public sealed record DeviceTaskClaimResponse(
    bool Claimed,
    TaskResponse? Task,
    TaskExecutionResponse? Execution,
    string? LeaseOwner,
    long? LeaseExpiresAtMs,
    CapabilityEnvelopeContract? CapabilityEnvelope = null);

public sealed record DeviceActiveTaskListResponse(IReadOnlyList<DeviceTaskClaimResponse> Items);

public sealed record DeviceApprovalStatusResponse(
    Guid ApprovalId,
    Guid TaskId,
    Guid ExecutionId,
    Guid DeviceId,
    ApprovalStatusValue Status,
    ApprovalDecisionValue? Decision,
    ApprovalScopeValue? Scope);

public sealed record DeviceTaskEventRequest(
    string ClientEventId,
    Guid ExecutionId,
    string EventType,
    string? PayloadJson = null,
    string? ProgressSummary = null,
    string? ResultSummary = null,
    string? ResultPayloadJson = null,
    IReadOnlyList<ArtifactManifestEntry>? Artifacts = null,
    string? CodexThreadId = null,
    string? CodexTurnId = null,
    string? ErrorCode = null,
    string? ErrorMessage = null);

public sealed record DeviceTaskEventResponse(
    Guid TaskId,
    Guid ExecutionId,
    bool Accepted,
    bool Deduplicated,
    TaskStatusValue Status,
    TaskExecutionStatusValue ExecutionStatus);

public sealed record DeviceTaskLeaseRenewRequest(string LeaseOwner);

public sealed record DeviceTaskLeaseRenewResponse(
    Guid TaskId,
    bool Renewed,
    long? LeaseExpiresAtMs,
    TaskStatusValue Status);

[JsonConverter(typeof(CamelCaseEnumConverter<TaskUserInputStatusValue>))]
public enum TaskUserInputStatusValue
{
    Pending,
    Answered,
    Cleared,
    Expired
}

public sealed record TaskUserInputOption(
    string Description,
    string Label);

public sealed record TaskUserInputQuestion(
    string Header,
    string Id,
    string Question,
    bool IsOther = false,
    bool IsSecret = false,
    IReadOnlyList<TaskUserInputOption>? Options = null);

/// <summary>
/// Safe task projection for UI clients. It never contains a submitted answer.
/// </summary>
public sealed record TaskUserInputResponse(
    string RequestId,
    string ItemId,
    string ThreadId,
    string TurnId,
    IReadOnlyList<TaskUserInputQuestion> Questions,
    TaskUserInputStatusValue Status = TaskUserInputStatusValue.Pending,
    long? ExpiresAtMs = null,
    bool RequestIdIsString = true);

public sealed record TaskUserInputAnswer(IReadOnlyList<string> Answers);

public sealed record TaskUserInputSubmissionRequest(
    string RequestId,
    IReadOnlyDictionary<string, TaskUserInputAnswer> Answers,
    Guid? ExecutionId = null,
    bool RequestIdIsString = true);

public sealed record TaskUserInputSubmissionResponse(
    Guid TaskId,
    Guid ExecutionId,
    string RequestId,
    bool Accepted,
    TaskStatusValue Status,
    TaskExecutionStatusValue ExecutionStatus);

/// <summary>
/// Device-only request projection of the pinned Codex item/tool/requestUserInput params.
/// RequestId is the JSON-RPC request id normalized to text by the adapter.
/// </summary>
public sealed record DeviceTaskUserInputRequest(
    Guid ExecutionId,
    string RequestId,
    string ItemId,
    IReadOnlyList<TaskUserInputQuestion> Questions,
    string ThreadId,
    string TurnId,
    long? AutoResolutionMs = null,
    bool RequestIdIsString = true);

public sealed record DeviceTaskUserInputResponse(
    Guid TaskId,
    Guid ExecutionId,
    string RequestId,
    string ItemId,
    string ThreadId,
    string TurnId,
    IReadOnlyList<TaskUserInputQuestion> Questions,
    TaskUserInputStatusValue Status,
    IReadOnlyDictionary<string, TaskUserInputAnswer>? Answers = null,
    long? ExpiresAtMs = null,
    bool RequestIdIsString = true);

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
    long? ActionedAtMs,
    Guid? ApprovalId = null);

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

public sealed record DeviceSummaryResponse(
    Guid DeviceId,
    string Name,
    DeviceTypeValue DeviceType,
    string Platform,
    DeviceStatusValue Status,
    IReadOnlyList<string> Capabilities,
    long? LastSeenAtMs,
    long PairedAtMs,
    long EntityVersion);

public sealed record DeviceListResponse(IReadOnlyList<DeviceSummaryResponse> Items);

public sealed record MobilePairingRequest(
    string DeviceName,
    string Platform,
    IReadOnlyList<string>? Capabilities = null);

public sealed record MobilePairingResponse(
    Guid PairingId,
    string Code,
    long ExpiresAtMs);

public sealed record MobilePairingExchangeRequest(
    string Code,
    string? DeviceName = null,
    string? Platform = null,
    IReadOnlyList<string>? Capabilities = null);

public sealed record MobileSessionResponse(
    Guid SessionId,
    Guid DeviceId,
    string AccessToken,
    long AccessTokenExpiresAtMs,
    string RefreshToken,
    long RefreshTokenExpiresAtMs);

public sealed record MobileSessionRefreshRequest(Guid SessionId, string RefreshToken);

public sealed record MobileSessionRevokeResponse(Guid SessionId, bool Revoked);

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
