using System.Text.Json;
using Jarvis.Contracts;
using Jarvis.Domain.Tasks;

namespace Jarvis.Application.Tasks;

public enum TaskStoreResultKind
{
    Created,
    Replayed,
    Conflict,
    StateConflict,
    Invalid,
    NotFound
}

public sealed record TaskCreateStoreResult(
    TaskStoreResultKind Kind,
    TaskAcceptedResponse? Accepted = null,
    TaskResponse? Response = null,
    string? Detail = null);

public sealed record TaskCancelStoreResult(
    TaskStoreResultKind Kind,
    TaskCancelResponse? Response = null,
    string? Detail = null);

public readonly record struct TaskListCursor(long CreatedAtMs, Guid Id)
{
    private const int MaxLength = 200;
    private static readonly JsonSerializerOptions JsonOptions = new(JsonSerializerDefaults.Web);

    public string Encode()
    {
        var payload = JsonSerializer.SerializeToUtf8Bytes(new CursorPayload(CreatedAtMs, Id), JsonOptions);
        return Convert.ToBase64String(payload)
            .TrimEnd('=')
            .Replace('+', '-')
            .Replace('/', '_');
    }

    public static bool TryDecode(string value, out TaskListCursor cursor)
    {
        cursor = default;
        if (string.IsNullOrWhiteSpace(value) || value.Length > MaxLength)
        {
            return false;
        }

        try
        {
            var normalized = value.Replace('-', '+').Replace('_', '/');
            normalized = normalized.PadRight(normalized.Length + (4 - normalized.Length % 4) % 4, '=');
            var payload = JsonSerializer.Deserialize<CursorPayload>(
                Convert.FromBase64String(normalized),
                JsonOptions);
            if (payload is null || payload.CreatedAtMs < 0 || payload.Id == Guid.Empty)
            {
                return false;
            }

            cursor = new(payload.CreatedAtMs, payload.Id);
            return true;
        }
        catch (FormatException)
        {
            return false;
        }
        catch (JsonException)
        {
            return false;
        }
    }

    private sealed record CursorPayload(long CreatedAtMs, Guid Id);
}

public interface ITaskStore
{
    Task<TaskCreateStoreResult> CreateAsync(
        Guid userId,
        string idempotencyKey,
        string requestHash,
        CreateTaskRequest request,
        IReadOnlyList<string> capabilities,
        WorkerKind workerKind,
        CancellationToken cancellationToken);

    Task<TaskResponse?> GetAsync(
        Guid userId,
        Guid taskId,
        CancellationToken cancellationToken);

    Task<TaskListResponse?> ListAsync(
        Guid userId,
        Guid? conversationId,
        TaskStatusValue? status,
        TaskListCursor? cursor,
        int limit,
        CancellationToken cancellationToken);

    Task<TaskCancelStoreResult> CancelAsync(
        Guid userId,
        Guid taskId,
        string idempotencyKey,
        string requestHash,
        CancellationToken cancellationToken);
}

public enum TaskUserInputOperationStatus
{
    Succeeded,
    Replayed,
    Conflict,
    StateConflict,
    Invalid,
    NotFound,
    Unauthorized
}

public sealed record TaskUserInputOperation<T>(
    TaskUserInputOperationStatus Status,
    T? Value = default,
    string? Detail = null);

public interface ITaskUserInputStore
{
    Task<TaskUserInputOperation<DeviceTaskUserInputResponse>> CreateDeviceRequestAsync(
        Guid deviceId,
        Guid taskId,
        DeviceTaskUserInputRequest request,
        string leaseOwner,
        string idempotencyKey,
        CancellationToken cancellationToken);

    Task<TaskUserInputOperation<DeviceTaskUserInputResponse>> GetDeviceRequestAsync(
        Guid deviceId,
        Guid taskId,
        Guid executionId,
        string requestId,
        bool requestIdIsString,
        string leaseOwner,
        CancellationToken cancellationToken);

    Task<TaskUserInputOperation<DeviceTaskUserInputResponse>> ResolveDeviceRequestAsync(
        Guid deviceId,
        Guid taskId,
        Guid executionId,
        string requestId,
        bool requestIdIsString,
        string leaseOwner,
        string idempotencyKey,
        CancellationToken cancellationToken);

    Task<TaskUserInputOperation<TaskUserInputSubmissionResponse>> SubmitAsync(
        Guid userId,
        Guid taskId,
        TaskUserInputSubmissionRequest request,
        string idempotencyKey,
        CancellationToken cancellationToken);

    Task<TaskUserInputResponse?> GetPendingAsync(Guid taskId, CancellationToken cancellationToken);
}

public sealed record FakeWorkItem(
    Guid TaskId,
    string Goal,
    string? ExpectedOutput,
    WorkerKind WorkerKind);

public sealed record FakeWorkResult(
    bool Succeeded,
    string ResultSummary,
    string? ResultPayloadJson = null,
    string? ErrorCode = null,
    string? ErrorMessage = null);

public interface IFakeDelayAdapter
{
    Task<FakeWorkResult> ExecuteAsync(FakeWorkItem workItem, CancellationToken cancellationToken);
}
