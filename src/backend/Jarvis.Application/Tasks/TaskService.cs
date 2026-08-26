using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Jarvis.Application.Devices;
using Jarvis.Contracts;
using Jarvis.Domain.Tasks;
using DomainTaskStatus = Jarvis.Domain.Tasks.TaskStatus;
using DomainWorkerKind = Jarvis.Domain.Tasks.WorkerKind;

namespace Jarvis.Application.Tasks;

public enum TaskOperationStatus
{
    Succeeded,
    Replayed,
    Conflict,
    StateConflict,
    Invalid,
    NotFound
}

public sealed record TaskOperation<T>(
    TaskOperationStatus Status,
    T? Value = default,
    string? Detail = null);

public sealed class TaskService(ITaskStore store)
{
    private const int MaxIdempotencyKeyLength = 200;
    private const int MaxGoalLength = 100_000;
    private const int MaxExpectedOutputLength = 100_000;
    private const int MaxCapabilities = 20;
    private const int MaxSourceMessages = 100;
    private const int MaxAttachmentRefs = 100;

    public async Task<TaskOperation<TaskAcceptedResponse>> CreateAsync(
        Guid userId,
        string? idempotencyKey,
        CreateTaskRequest? request,
        CancellationToken cancellationToken)
    {
        var validation = ValidateIdempotencyKey(idempotencyKey);
        if (validation is not null)
        {
            return Invalid<TaskAcceptedResponse>(validation);
        }

        if (request is null || request.ConversationId == Guid.Empty)
        {
            return Invalid<TaskAcceptedResponse>("conversationId is required.");
        }

        if (string.IsNullOrWhiteSpace(request.Goal) || request.Goal.Length > MaxGoalLength)
        {
            return Invalid<TaskAcceptedResponse>("goal is required and must be at most 100000 characters.");
        }

        if (request.ExpectedOutput is { Length: > MaxExpectedOutputLength })
        {
            return Invalid<TaskAcceptedResponse>("expectedOutput is too long.");
        }

        var capabilities = (request.RequiredCapabilities ?? Array.Empty<string>())
            .Where(capability => !string.IsNullOrWhiteSpace(capability))
            .Select(capability => capability.Trim())
            .Distinct(StringComparer.Ordinal)
            .ToArray();
        if (capabilities.Length > MaxCapabilities)
        {
            return Invalid<TaskAcceptedResponse>("requiredCapabilities contains too many items.");
        }

        try
        {
            var workerKind = WorkerRouter.Route(capabilities);
            var capabilityEnvelope = NormalizeCapabilityEnvelope(workerKind, capabilities, request.CapabilityEnvelope);
            var sourceMessageIds = (request.SourceMessageIds ?? Array.Empty<Guid>()).Distinct().ToArray();
            if (sourceMessageIds.Length > MaxSourceMessages || sourceMessageIds.Any(id => id == Guid.Empty))
            {
                return Invalid<TaskAcceptedResponse>("sourceMessageIds is invalid.");
            }

            var attachmentRefs = (request.AttachmentRefs ?? Array.Empty<string>()).ToArray();
            if (attachmentRefs.Length > MaxAttachmentRefs
                || attachmentRefs.Any(reference => string.IsNullOrWhiteSpace(reference) || reference.Length > 2_000))
            {
                return Invalid<TaskAcceptedResponse>("attachmentRefs is invalid.");
            }

            request = request with
            {
                Goal = request.Goal.Trim(),
                ExpectedOutput = string.IsNullOrWhiteSpace(request.ExpectedOutput) ? null : request.ExpectedOutput.Trim(),
                RequiredCapabilities = capabilities,
                SourceMessageIds = sourceMessageIds,
                AttachmentRefs = attachmentRefs,
                CapabilityEnvelope = capabilityEnvelope
            };

            var hash = RequestHash.Create(request);
            var result = await store.CreateAsync(
                userId,
                idempotencyKey!.Trim(),
                hash,
                request,
                capabilities,
                workerKind,
                cancellationToken);
            return result.Kind switch
            {
                TaskStoreResultKind.Created => new(TaskOperationStatus.Succeeded, result.Accepted),
                TaskStoreResultKind.Replayed => new(TaskOperationStatus.Replayed, result.Accepted),
                TaskStoreResultKind.Invalid => Invalid<TaskAcceptedResponse>(result.Detail ?? "Invalid task request."),
                TaskStoreResultKind.NotFound => new(TaskOperationStatus.NotFound),
                _ => new(TaskOperationStatus.Conflict, Detail: result.Detail ?? "The Idempotency-Key conflicts with an existing request.")
            };
        }
        catch (ArgumentException exception)
        {
            return Invalid<TaskAcceptedResponse>(exception.Message);
        }
    }

    public async Task<TaskOperation<TaskResponse>> GetAsync(
        Guid userId,
        Guid taskId,
        CancellationToken cancellationToken)
    {
        if (taskId == Guid.Empty)
        {
            return Invalid<TaskResponse>("taskId is required.");
        }

        var response = await store.GetAsync(userId, taskId, cancellationToken);
        return response is null
            ? new(TaskOperationStatus.NotFound)
            : new(TaskOperationStatus.Succeeded, response);
    }

    public async Task<TaskOperation<TaskListResponse>> ListAsync(
        Guid userId,
        Guid? conversationId,
        string? status,
        string? cursor,
        int limit,
        CancellationToken cancellationToken)
    {
        if (conversationId is Guid id && id == Guid.Empty)
        {
            return Invalid<TaskListResponse>("conversationId is invalid.");
        }

        TaskListCursor? parsedCursor = null;
        if (cursor is not null)
        {
            if (!TaskListCursor.TryDecode(cursor, out var decodedCursor))
            {
                return Invalid<TaskListResponse>("cursor is invalid.");
            }

            parsedCursor = decodedCursor;
        }

        if (limit is < 1 or > 100)
        {
            return Invalid<TaskListResponse>("limit must be between 1 and 100.");
        }

        TaskStatusValue? parsedStatus = null;
        if (!string.IsNullOrWhiteSpace(status))
        {
            if (!Enum.TryParse<TaskStatusValue>(status, ignoreCase: true, out var candidate)
                || !Enum.IsDefined(candidate))
            {
                return Invalid<TaskListResponse>("status is invalid.");
            }

            parsedStatus = candidate;
        }

        var response = await store.ListAsync(userId, conversationId, parsedStatus, parsedCursor, limit, cancellationToken);
        return response is null
            ? new(TaskOperationStatus.NotFound)
            : new(TaskOperationStatus.Succeeded, response);
    }

    public async Task<TaskOperation<TaskCancelResponse>> CancelAsync(
        Guid userId,
        Guid taskId,
        string? idempotencyKey,
        CancellationToken cancellationToken)
    {
        var validation = ValidateIdempotencyKey(idempotencyKey);
        if (validation is not null)
        {
            return Invalid<TaskCancelResponse>(validation);
        }

        if (taskId == Guid.Empty)
        {
            return Invalid<TaskCancelResponse>("taskId is required.");
        }

        var requestHash = RequestHash.Create(new { taskId });
        var result = await store.CancelAsync(
            userId,
            taskId,
            idempotencyKey!.Trim(),
            requestHash,
            cancellationToken);
        return result.Kind switch
        {
            TaskStoreResultKind.Created => new(TaskOperationStatus.Succeeded, result.Response),
            TaskStoreResultKind.Replayed => new(TaskOperationStatus.Replayed, result.Response),
            TaskStoreResultKind.NotFound => new(TaskOperationStatus.NotFound),
            TaskStoreResultKind.StateConflict => new(TaskOperationStatus.StateConflict, result.Response, result.Detail),
            TaskStoreResultKind.Invalid => Invalid<TaskCancelResponse>(result.Detail ?? "Invalid cancellation request."),
            _ => new(TaskOperationStatus.Conflict, Detail: result.Detail ?? "The Idempotency-Key conflicts with an existing request.")
        };
    }

    private static string? ValidateIdempotencyKey(string? key)
    {
        return string.IsNullOrWhiteSpace(key)
            ? "The Idempotency-Key header is required."
            : key.Trim().Length > MaxIdempotencyKeyLength
                ? "The Idempotency-Key header is too long."
                : null;
    }

    private static CapabilityEnvelopeContract? NormalizeCapabilityEnvelope(
        DomainWorkerKind workerKind,
        IReadOnlyList<string> requiredCapabilities,
        CapabilityEnvelopeContract? envelope)
    {
        if (workerKind != DomainWorkerKind.Codex)
        {
            if (envelope is not null)
            {
                throw new ArgumentException("capabilityEnvelope is only valid for Codex tasks.");
            }

            return null;
        }

        if (envelope is null)
        {
            throw new ArgumentException("capabilityEnvelope is required for Codex tasks.");
        }

        var policy = CapabilityPolicy.Create(new CapabilityEnvelope(
            envelope.ReadFiles,
            envelope.WriteFiles,
            envelope.RunCommands,
            envelope.Network,
            envelope.AllowedRoots));
        if (!policy.ReadFiles
            || policy.AllowedRoots.Count == 0
            || policy.AllowedRoots.Any(root => !policy.IsAllowedPath(root, write: false))
            || policy.WriteFiles && !policy.ReadFiles
            || policy.RunCommands && !policy.ReadFiles)
        {
            throw new ArgumentException("Codex tasks require a readable, non-sensitive absolute allowed root.");
        }

        foreach (var capability in requiredCapabilities)
        {
            if (string.Equals(capability, "localFiles", StringComparison.Ordinal) && !policy.ReadFiles
                || string.Equals(capability, "writeFiles", StringComparison.Ordinal) && !policy.WriteFiles
                || string.Equals(capability, "runCommands", StringComparison.Ordinal) && !policy.RunCommands
                || string.Equals(capability, "network", StringComparison.Ordinal) && !policy.Network)
            {
                throw new ArgumentException($"capabilityEnvelope does not permit required capability '{capability}'.");
            }
        }

        return new CapabilityEnvelopeContract(
            policy.ReadFiles,
            policy.WriteFiles,
            policy.RunCommands,
            policy.Network,
            policy.AllowedRoots);
    }

    private static TaskOperation<T> Invalid<T>(string detail) => new(TaskOperationStatus.Invalid, Detail: detail);

    private static class RequestHash
    {
        private static readonly JsonSerializerOptions Options = new(JsonSerializerDefaults.Web);

        public static string Create<T>(T request)
        {
            var json = JsonSerializer.Serialize(request, Options);
            return Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(json)));
        }
    }
}
