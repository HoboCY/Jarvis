using Jarvis.Contracts;

namespace Jarvis.Application.Tasks;

public sealed class TaskUserInputService(ITaskUserInputStore store)
{
    private const int MaxIdempotencyKeyLength = 200;
    public Task<TaskUserInputOperation<TaskUserInputSubmissionResponse>> SubmitAsync(
        Guid userId,
        Guid taskId,
        string? idempotencyKey,
        TaskUserInputSubmissionRequest? request,
        CancellationToken cancellationToken)
    {
        if (userId == Guid.Empty || taskId == Guid.Empty)
        {
            return Task.FromResult(Invalid<TaskUserInputSubmissionResponse>("Task identity is invalid."));
        }

        if (string.IsNullOrWhiteSpace(idempotencyKey) || idempotencyKey.Trim().Length > MaxIdempotencyKeyLength)
        {
            return Task.FromResult(Invalid<TaskUserInputSubmissionResponse>("The Idempotency-Key header is required and is too long."));
        }

        if (request is null || !TaskUserInputValidation.TryValidateSubmission(request, Array.Empty<TaskUserInputQuestion>(), out _))
        {
            // The store repeats validation after loading the durable question set. This
            // guard only rejects malformed envelopes before they cross the application seam.
            if (request is null || string.IsNullOrWhiteSpace(request.RequestId) || request.Answers is null)
            {
                return Task.FromResult(Invalid<TaskUserInputSubmissionResponse>("A user-input submission is required."));
            }
        }

        return store.SubmitAsync(userId, taskId, request!, idempotencyKey.Trim(), cancellationToken);
    }

    private static TaskUserInputOperation<T> Invalid<T>(string detail) => new(TaskUserInputOperationStatus.Invalid, Detail: detail);
}
