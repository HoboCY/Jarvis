using Jarvis.Contracts;

namespace Jarvis.Application.Devices;

public sealed record DeviceIdentity(Guid DeviceId, Guid UserId, string CredentialHash);

public enum DeviceOperationStatus
{
    Succeeded,
    Replayed,
    NotFound,
    Conflict,
    Invalid,
    Unauthorized
}

public sealed record DeviceOperation<T>(DeviceOperationStatus Status, T? Value = default, string? Detail = null);

public interface IDeviceStore
{
    Task<DeviceOperation<DeviceRegistrationResponse>> RegisterAsync(
        Guid userId,
        DeviceRegistrationRequest request,
        string? idempotencyKey,
        CancellationToken cancellationToken);

    Task<DeviceIdentity?> AuthenticateAsync(string credential, CancellationToken cancellationToken);

    Task<DeviceOperation<DeviceHeartbeatResponse>> HeartbeatAsync(
        Guid deviceId,
        DeviceHeartbeatRequest request,
        string? idempotencyKey,
        CancellationToken cancellationToken);

    Task<DeviceOperation<DeviceTaskClaimResponse>> ClaimAsync(
        Guid deviceId,
        DeviceTaskClaimRequest request,
        string? idempotencyKey,
        CancellationToken cancellationToken);

    Task<DeviceOperation<DeviceActiveTaskListResponse>> ListActiveAsync(
        Guid deviceId,
        CancellationToken cancellationToken);

    Task<DeviceOperation<TaskResponse>> GetTaskAsync(Guid deviceId, Guid taskId, CancellationToken cancellationToken);

    Task<DeviceOperation<DeviceTaskLeaseRenewResponse>> RenewLeaseAsync(
        Guid deviceId,
        Guid taskId,
        DeviceTaskLeaseRenewRequest request,
        string? idempotencyKey,
        CancellationToken cancellationToken);

    Task<DeviceOperation<DeviceTaskEventResponse>> AppendEventAsync(
        Guid deviceId,
        Guid taskId,
        DeviceTaskEventRequest request,
        string? leaseOwner,
        string? idempotencyKey,
        CancellationToken cancellationToken);

    Task<DeviceOperation<DeviceApprovalResponse>> CreateApprovalAsync(
        Guid deviceId,
        Guid taskId,
        DeviceApprovalRequest request,
        string? leaseOwner,
        string? idempotencyKey,
        CancellationToken cancellationToken);

    Task<DeviceOperation<DeviceApprovalStatusResponse>> GetApprovalAsync(Guid deviceId, Guid taskId, Guid approvalId, CancellationToken cancellationToken);
}

public sealed class DeviceCoordinationService(IDeviceStore store)
{
    private static readonly HashSet<string> SupportedTaskEventTypes = new(StringComparer.Ordinal)
    {
        "codex.turn.starting",
        "codex.turn.started",
        "codex.progress",
        "task.completed",
        "task.recovering",
        "task.failed",
        "task.cancelled"
    };

    public Task<DeviceOperation<DeviceRegistrationResponse>> RegisterAsync(
        Guid userId,
        DeviceRegistrationRequest? request,
        string? idempotencyKey,
        CancellationToken cancellationToken)
    {
        if (request is null || userId == Guid.Empty)
        {
            return Task.FromResult(new DeviceOperation<DeviceRegistrationResponse>(DeviceOperationStatus.Invalid, Detail: "A device registration request is required."));
        }

        if (string.IsNullOrWhiteSpace(request.Name) || request.Name.Length > 200
            || string.IsNullOrWhiteSpace(request.Platform) || request.Platform.Length > 64)
        {
            return Task.FromResult(new DeviceOperation<DeviceRegistrationResponse>(DeviceOperationStatus.Invalid, Detail: "Device name and platform are required."));
        }

        var capabilities = NormalizeCapabilities(request.Capabilities);
        if (capabilities is null)
        {
            return Task.FromResult(new DeviceOperation<DeviceRegistrationResponse>(DeviceOperationStatus.Invalid, Detail: "Capabilities are invalid."));
        }

        string[] roots;
        try
        {
            roots = NormalizeRoots(request.AllowedRoots);
        }
        catch (ArgumentException exception)
        {
            return Task.FromResult(new DeviceOperation<DeviceRegistrationResponse>(DeviceOperationStatus.Invalid, Detail: exception.Message));
        }

        return store.RegisterAsync(userId, request with { Name = request.Name.Trim(), Platform = request.Platform.Trim(), Capabilities = capabilities, AllowedRoots = roots }, idempotencyKey, cancellationToken);
    }

    public Task<DeviceOperation<DeviceHeartbeatResponse>> HeartbeatAsync(
        Guid deviceId,
        DeviceHeartbeatRequest? request,
        string? idempotencyKey,
        CancellationToken cancellationToken)
    {
        var capabilities = NormalizeCapabilities(request?.Capabilities);
        string[]? roots = null;
        try
        {
            roots = request is null ? null : NormalizeRoots(request.AllowedRoots);
        }
        catch (ArgumentException exception)
        {
            return Task.FromResult(new DeviceOperation<DeviceHeartbeatResponse>(DeviceOperationStatus.Invalid, Detail: exception.Message));
        }

        return deviceId == Guid.Empty || capabilities is null || roots is null
            ? Task.FromResult(new DeviceOperation<DeviceHeartbeatResponse>(DeviceOperationStatus.Invalid, Detail: "Device heartbeat is invalid."))
            : store.HeartbeatAsync(deviceId, new DeviceHeartbeatRequest(capabilities, roots), idempotencyKey, cancellationToken);
    }

    public Task<DeviceOperation<DeviceTaskClaimResponse>> ClaimAsync(
        Guid deviceId,
        DeviceTaskClaimRequest? request,
        string? idempotencyKey,
        CancellationToken cancellationToken)
    {
        var leaseOwner = request?.LeaseOwner;
        if (deviceId == Guid.Empty || (leaseOwner is not null && (string.IsNullOrWhiteSpace(leaseOwner) || leaseOwner.Length > 200)))
        {
            return Task.FromResult(new DeviceOperation<DeviceTaskClaimResponse>(DeviceOperationStatus.Invalid, Detail: "Lease owner is invalid."));
        }

        return store.ClaimAsync(deviceId, request ?? new DeviceTaskClaimRequest(), idempotencyKey, cancellationToken);
    }

    public Task<DeviceOperation<DeviceTaskLeaseRenewResponse>> RenewLeaseAsync(
        Guid deviceId,
        Guid taskId,
        DeviceTaskLeaseRenewRequest? request,
        string? idempotencyKey,
        CancellationToken cancellationToken)
    {
        if (deviceId == Guid.Empty || taskId == Guid.Empty || request is null || string.IsNullOrWhiteSpace(request.LeaseOwner) || request.LeaseOwner.Length > 200)
        {
            return Task.FromResult(new DeviceOperation<DeviceTaskLeaseRenewResponse>(DeviceOperationStatus.Invalid, Detail: "Lease renewal is invalid."));
        }

        return store.RenewLeaseAsync(deviceId, taskId, request with { LeaseOwner = request.LeaseOwner.Trim() }, idempotencyKey, cancellationToken);
    }

    public Task<DeviceOperation<DeviceActiveTaskListResponse>> ListActiveAsync(
        Guid deviceId,
        CancellationToken cancellationToken) =>
        deviceId == Guid.Empty
            ? Task.FromResult(new DeviceOperation<DeviceActiveTaskListResponse>(DeviceOperationStatus.Invalid, Detail: "Device identity is invalid."))
            : store.ListActiveAsync(deviceId, cancellationToken);

    public Task<DeviceOperation<TaskResponse>> GetTaskAsync(Guid deviceId, Guid taskId, CancellationToken cancellationToken) =>
        deviceId == Guid.Empty || taskId == Guid.Empty
            ? Task.FromResult(new DeviceOperation<TaskResponse>(DeviceOperationStatus.Invalid, Detail: "Task identity is invalid."))
            : store.GetTaskAsync(deviceId, taskId, cancellationToken);

    public Task<DeviceOperation<DeviceTaskEventResponse>> AppendEventAsync(
        Guid deviceId,
        Guid taskId,
        DeviceTaskEventRequest? request,
        string? leaseOwner,
        string? idempotencyKey,
        CancellationToken cancellationToken)
    {
        if (deviceId == Guid.Empty || taskId == Guid.Empty || request is null || string.IsNullOrWhiteSpace(request.ClientEventId) || request.ClientEventId.Length > 200 || request.ExecutionId == Guid.Empty || string.IsNullOrWhiteSpace(request.EventType))
        {
            return Task.FromResult(new DeviceOperation<DeviceTaskEventResponse>(DeviceOperationStatus.Invalid, Detail: "Device task event is invalid."));
        }

        var normalized = request with { ClientEventId = request.ClientEventId.Trim(), EventType = request.EventType.Trim() };
        if (!SupportedTaskEventTypes.Contains(normalized.EventType))
        {
            return Task.FromResult(new DeviceOperation<DeviceTaskEventResponse>(DeviceOperationStatus.Invalid, Detail: "The device task event type is not supported."));
        }

        return store.AppendEventAsync(deviceId, taskId, normalized, leaseOwner, idempotencyKey, cancellationToken);
    }

    public Task<DeviceOperation<DeviceApprovalResponse>> CreateApprovalAsync(
        Guid deviceId,
        Guid taskId,
        DeviceApprovalRequest? request,
        string? leaseOwner,
        string? idempotencyKey,
        CancellationToken cancellationToken)
    {
        if (deviceId == Guid.Empty || taskId == Guid.Empty || request is null || request.ExecutionId == Guid.Empty || string.IsNullOrWhiteSpace(request.Reason) || string.IsNullOrWhiteSpace(request.RequestedActionJson) || string.IsNullOrWhiteSpace(leaseOwner) || leaseOwner.Length > 200)
        {
            return Task.FromResult(new DeviceOperation<DeviceApprovalResponse>(DeviceOperationStatus.Invalid, Detail: "Approval request is invalid."));
        }

        return store.CreateApprovalAsync(deviceId, taskId, request with { Reason = request.Reason.Trim() }, leaseOwner.Trim(), idempotencyKey, cancellationToken);
    }

    public Task<DeviceOperation<DeviceApprovalStatusResponse>> GetApprovalAsync(Guid deviceId, Guid taskId, Guid approvalId, CancellationToken cancellationToken) =>
        deviceId == Guid.Empty || taskId == Guid.Empty || approvalId == Guid.Empty
            ? Task.FromResult(new DeviceOperation<DeviceApprovalStatusResponse>(DeviceOperationStatus.Invalid, Detail: "Approval identity is invalid."))
            : store.GetApprovalAsync(deviceId, taskId, approvalId, cancellationToken);

    private static string[]? NormalizeCapabilities(IReadOnlyList<string>? values)
    {
        values ??= Array.Empty<string>();
        if (values.Count > 50 || values.Any(value => string.IsNullOrWhiteSpace(value) || value.Length > 100))
        {
            return null;
        }

        return values
            .Select(value => value.Trim())
            .Distinct(StringComparer.Ordinal)
            .ToArray();
    }

    private static string[] NormalizeRoots(IReadOnlyList<string>? values)
    {
        var envelope = new CapabilityEnvelope(ReadFiles: true, WriteFiles: true, AllowedRoots: values ?? Array.Empty<string>());
        return CapabilityPolicy.Create(envelope).AllowedRoots.ToArray();
    }
}
