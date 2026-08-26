using Jarvis.Contracts;

namespace Jarvis.Application.Approvals;

public enum ApprovalOperationStatus
{
    Succeeded,
    Replayed,
    NotFound,
    Conflict,
    Invalid
}

public sealed record ApprovalOperation<T>(ApprovalOperationStatus Status, T? Value = default, string? Detail = null);

public interface IApprovalStore
{
    Task<ApprovalListResponse> ListPendingAsync(Guid userId, CancellationToken cancellationToken);

    Task<ApprovalOperation<ApprovalResponse>> DecideAsync(
        Guid userId,
        Guid approvalId,
        ApprovalDecisionRequest request,
        string? idempotencyKey,
        CancellationToken cancellationToken);
}

public sealed class ApprovalService(IApprovalStore store)
{
    public Task<ApprovalListResponse> ListPendingAsync(Guid userId, string? status, CancellationToken cancellationToken)
    {
        if (userId == Guid.Empty)
        {
            return Task.FromResult(new ApprovalListResponse(Array.Empty<ApprovalResponse>()));
        }

        return string.IsNullOrWhiteSpace(status) || string.Equals(status, "pending", StringComparison.OrdinalIgnoreCase)
            ? store.ListPendingAsync(userId, cancellationToken)
            : Task.FromResult(new ApprovalListResponse(Array.Empty<ApprovalResponse>()));
    }

    public Task<ApprovalOperation<ApprovalResponse>> DecideAsync(
        Guid userId,
        Guid approvalId,
        ApprovalDecisionRequest? request,
        string? idempotencyKey,
        CancellationToken cancellationToken)
    {
        if (userId == Guid.Empty || approvalId == Guid.Empty || request is null || string.IsNullOrWhiteSpace(request.ClientRequestId) || request.ClientRequestId.Length > 200)
        {
            return Task.FromResult(new ApprovalOperation<ApprovalResponse>(ApprovalOperationStatus.Invalid, Detail: "Approval decision is invalid."));
        }

        return store.DecideAsync(userId, approvalId, request with { ClientRequestId = request.ClientRequestId.Trim() }, idempotencyKey, cancellationToken);
    }
}
