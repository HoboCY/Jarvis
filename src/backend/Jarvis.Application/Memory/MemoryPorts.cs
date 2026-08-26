using Jarvis.Contracts;

namespace Jarvis.Application.Memory;

public enum MemoryOperationStatus
{
    Succeeded,
    Replayed,
    Conflict,
    Invalid,
    NotFound
}

public sealed record MemoryOperation<T>(
    MemoryOperationStatus Status,
    T? Value = default,
    string? Detail = null);

public sealed record MemoryFactContextItem(
    string Key,
    string Value,
    bool Sensitive,
    long EntityVersion,
    Guid MemoryId);

public interface IMemoryStore
{
    Task<MemoryOperation<MemoryFactSaveResponse>> SaveAsync(
        Guid userId,
        string idempotencyKey,
        string requestHash,
        CreateMemoryFactRequest request,
        bool allowSensitive,
        CancellationToken cancellationToken);

    Task<MemoryOperation<MemoryFactRetractResponse>> RetractAsync(
        Guid userId,
        Guid memoryId,
        string idempotencyKey,
        string requestHash,
        CancellationToken cancellationToken);

    Task<IReadOnlyList<MemoryFactContextItem>> GetActiveForContextAsync(
        Guid userId,
        CancellationToken cancellationToken,
        int maxItems = 100);
}
