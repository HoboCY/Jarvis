using System.Text.Json.Serialization;

namespace Jarvis.Contracts;

[JsonConverter(typeof(CamelCaseEnumConverter<MemoryFactStatusValue>))]
public enum MemoryFactStatusValue
{
    Active,
    Retracted
}

public sealed record CreateMemoryFactRequest(
    string Key,
    string Value,
    Guid SourceMessageId,
    bool Sensitive = false);

public sealed record MemoryFactSaveResponse(bool Saved, Guid MemoryId);

public sealed record MemoryFactResponse(
    Guid Id,
    Guid UserId,
    string Key,
    string Value,
    Guid? SourceMessageId,
    double Confidence,
    bool Sensitive,
    MemoryFactStatusValue Status,
    Guid? SupersedesMemoryId,
    long? LastConfirmedAtMs,
    long CreatedAtMs,
    long UpdatedAtMs,
    long EntityVersion);

public sealed record MemoryFactRetractResponse(
    Guid MemoryId,
    bool Retracted,
    MemoryFactStatusValue Status);
