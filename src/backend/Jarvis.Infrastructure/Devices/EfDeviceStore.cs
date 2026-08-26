using System.Data;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Jarvis.Application.Approvals;
using Jarvis.Application.Devices;
using Jarvis.Contracts;
using Jarvis.Domain.Approvals;
using Jarvis.Domain.Devices;
using Jarvis.Domain.Idempotency;
using Jarvis.Domain.Notifications;
using Jarvis.Domain.Outbox;
using Jarvis.Domain.Tasks;
using Jarvis.Infrastructure.Data;
using Jarvis.Infrastructure.Idempotency;
using Jarvis.Infrastructure.Observability;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Options;
using DomainTask = Jarvis.Domain.Tasks.Task;
using DomainTaskStatus = Jarvis.Domain.Tasks.TaskStatus;
using DomainTaskEvent = Jarvis.Domain.Tasks.TaskEvent;

namespace Jarvis.Infrastructure.Devices;

public sealed class EfDeviceStore(
    JarvisDbContext db,
    TimeProvider timeProvider,
    IOptions<IdempotencyOptions> idempotencyOptions) : IDeviceStore, IApprovalStore
{
    private static readonly JsonSerializerOptions JsonOptions = new(JsonSerializerDefaults.Web);
    private const long LeaseDurationMs = 30_000;
    private const long DeviceHeartbeatFreshnessMs = 60_000;
    private const long ApprovalLifetimeMs = 5 * 60_000;

    public async Task<DeviceOperation<DeviceRegistrationResponse>> RegisterAsync(
        Guid userId,
        DeviceRegistrationRequest request,
        string? idempotencyKey,
        CancellationToken cancellationToken)
    {
        if (string.IsNullOrWhiteSpace(idempotencyKey) || idempotencyKey.Length > 200)
        {
            return Invalid<DeviceRegistrationResponse>("The Idempotency-Key header is required.");
        }

        const string scopeSuffix = "devices:register";
        var requestHash = Hash(request);
        var existing = await FindIdempotencyAsync(userId, scopeSuffix, idempotencyKey, cancellationToken);
        if (existing is not null)
        {
            return !string.Equals(existing.RequestHash, requestHash, StringComparison.Ordinal)
                ? new(DeviceOperationStatus.Conflict, Detail: "The Idempotency-Key was already used with a different payload.")
                : new(DeviceOperationStatus.Conflict, Detail: "The one-time device credential was already issued and is not persisted. Pair the device again.");
        }

        await using var transaction = await db.Database.BeginTransactionAsync(IsolationLevel.Serializable, cancellationToken);
        var nowMs = Now();
        var capabilities = NormalizeCapabilities(request.Capabilities);
        var allowedRoots = NormalizeAllowedRoots(request.AllowedRoots);
        var credential = Convert.ToBase64String(RandomNumberGenerator.GetBytes(32)).TrimEnd('=').Replace('+', '-').Replace('/', '_');
        var device = Device.Register(
            Guid.CreateVersion7(),
            userId,
            request.Name,
            ToDomainDeviceType(request.DeviceType),
            request.Platform,
            JsonSerializer.Serialize(capabilities, JsonOptions),
            HashCredential(credential),
            nowMs,
            JsonSerializer.Serialize(allowedRoots, JsonOptions));
        db.Devices.Add(device);
        var response = new DeviceRegistrationResponse(
            device.Id,
            userId,
            device.Name,
            request.DeviceType,
            device.Platform,
            capabilities,
            ToContractStatus(device.Status),
            credential);
        AddIdempotency(
            userId,
            scopeSuffix,
            idempotencyKey,
            requestHash,
            201,
            new { response.DeviceId, CredentialIssued = true },
            nowMs);
        await db.SaveChangesAsync(cancellationToken);
        await transaction.CommitAsync(cancellationToken);
        return new(DeviceOperationStatus.Succeeded, response);
    }

    public async Task<DeviceIdentity?> AuthenticateAsync(string credential, CancellationToken cancellationToken)
    {
        if (string.IsNullOrWhiteSpace(credential))
        {
            return null;
        }

        var hash = HashCredential(credential);
        return await db.Devices
            .AsNoTracking()
            .Where(device => device.CredentialHash == hash && device.Status != DeviceStatus.Disabled && device.CredentialHash != null)
            .Select(device => new DeviceIdentity(device.Id, device.UserId, device.CredentialHash!))
            .SingleOrDefaultAsync(cancellationToken);
    }

    public async Task<DeviceOperation<DeviceHeartbeatResponse>> HeartbeatAsync(
        Guid deviceId,
        DeviceHeartbeatRequest request,
        string? idempotencyKey,
        CancellationToken cancellationToken)
    {
        if (string.IsNullOrWhiteSpace(idempotencyKey) || idempotencyKey.Length > 200)
        {
            return Invalid<DeviceHeartbeatResponse>("The Idempotency-Key header is required.");
        }

        var device = await db.Devices.SingleOrDefaultAsync(item => item.Id == deviceId, cancellationToken);
        if (device is null)
        {
            return new(DeviceOperationStatus.NotFound, Detail: "Device not found.");
        }

        const string scopeSuffix = "heartbeat";
        var requestHash = Hash(request);
        var existing = await FindIdempotencyAsync(device.UserId, $"devices:{deviceId:D}:{scopeSuffix}", idempotencyKey, cancellationToken);
        if (existing is not null)
        {
            return Replay<DeviceHeartbeatResponse>(existing, requestHash, json => JsonSerializer.Deserialize<DeviceHeartbeatResponse>(json, JsonOptions));
        }

        var nowMs = Now();
        var allowedRoots = IntersectAllowedRoots(
            DeserializeList(device.AllowedRootsJson),
            request.AllowedRoots);
        var registeredCapabilities = DeserializeList(device.CapabilitiesJson);
        var heartbeatCapabilities = NormalizeCapabilities(request.Capabilities)
            .Where(capability => registeredCapabilities.Contains(capability, StringComparer.Ordinal))
            .ToArray();
        if (!device.Heartbeat(
            JsonSerializer.Serialize(heartbeatCapabilities, JsonOptions),
            nowMs,
            JsonSerializer.Serialize(allowedRoots, JsonOptions)))
        {
            return new(DeviceOperationStatus.Conflict, Detail: "The device is disabled.");
        }

        var response = new DeviceHeartbeatResponse(
            device.Id,
            ToContractStatus(device.Status),
            device.LastSeenAtMs ?? nowMs,
            heartbeatCapabilities,
            device.Version);
        AddIdempotency(device.UserId, $"devices:{deviceId:D}:{scopeSuffix}", idempotencyKey, requestHash, 200, response, nowMs);
        await db.SaveChangesAsync(cancellationToken);
        return new(DeviceOperationStatus.Succeeded, response);
    }

    public async Task<DeviceOperation<DeviceTaskClaimResponse>> ClaimAsync(
        Guid deviceId,
        DeviceTaskClaimRequest request,
        string? idempotencyKey,
        CancellationToken cancellationToken)
    {
        if (string.IsNullOrWhiteSpace(idempotencyKey) || idempotencyKey.Length > 200)
        {
            return Invalid<DeviceTaskClaimResponse>("The Idempotency-Key header is required.");
        }

        var device = await db.Devices.AsNoTracking().SingleOrDefaultAsync(item => item.Id == deviceId, cancellationToken);
        var claimStartedAtMs = Now();
        if (device is null
            || device.Status != DeviceStatus.Online
            || device.LastSeenAtMs is not long lastSeenAtMs
            || lastSeenAtMs <= claimStartedAtMs - DeviceHeartbeatFreshnessMs)
        {
            return new(DeviceOperationStatus.Unauthorized, Detail: "The device must have a recent heartbeat before claiming work.");
        }

        var leaseOwner = string.IsNullOrWhiteSpace(request.LeaseOwner) ? deviceId.ToString("N") : request.LeaseOwner.Trim();
        if (leaseOwner.Length > 200)
        {
            return Invalid<DeviceTaskClaimResponse>("Lease owner is too long.");
        }

        const string scopeSuffix = "claim";
        var requestHash = Hash(request);
        var existing = await FindIdempotencyAsync(device.UserId, $"devices:{deviceId:D}:{scopeSuffix}", idempotencyKey, cancellationToken);
        if (existing is not null)
        {
            return Replay<DeviceTaskClaimResponse>(existing, requestHash, json => JsonSerializer.Deserialize<DeviceTaskClaimResponse>(json, JsonOptions));
        }

        await using var transaction = await db.Database.BeginTransactionAsync(IsolationLevel.Serializable, cancellationToken);
        var nowMs = Now();
        var candidates = await db.Tasks
            .OrderBy(item => item.Priority)
            .ThenBy(item => item.CreatedAtMs)
            .Where(item =>
                item.WorkerKind == WorkerKind.Codex
                && (item.Status == DomainTaskStatus.Queued || item.Status == DomainTaskStatus.Recovering)
                && (item.PreferredDeviceId == null || item.PreferredDeviceId == deviceId))
            .ToListAsync(cancellationToken);
        DomainTask? task = null;
        CapabilityEnvelopeContract? effectiveEnvelope = null;
        foreach (var candidate in candidates)
        {
            var candidateEnvelope = BuildEffectiveEnvelope(
                device,
                DeserializeCapabilityEnvelope(candidate.CapabilityEnvelopeJson),
                request.CapabilityEnvelope);
            if (!DeviceSupports(device.CapabilitiesJson, candidate.RequiredCapabilitiesJson)
                || !EnvelopeSupports(candidateEnvelope, candidate.RequiredCapabilitiesJson))
            {
                continue;
            }

            task = candidate;
            effectiveEnvelope = candidateEnvelope;
            break;
        }

        if (task is null)
        {
            var emptyResponse = new DeviceTaskClaimResponse(false, null, null, null, null);
            AddIdempotency(device.UserId, $"devices:{deviceId:D}:{scopeSuffix}", idempotencyKey, requestHash, 200, emptyResponse, nowMs);
            await db.SaveChangesAsync(cancellationToken);
            await transaction.CommitAsync(cancellationToken);
            return new(DeviceOperationStatus.Succeeded, emptyResponse);
        }

        System.Diagnostics.Debug.Assert(effectiveEnvelope is not null);

        var activeExecution = await db.TaskExecutions
            .Where(execution =>
            execution.TaskId == task.Id
            && execution.Status != TaskExecutionStatus.Succeeded
            && execution.Status != TaskExecutionStatus.Failed
            && execution.Status != TaskExecutionStatus.Cancelled)
            .OrderByDescending(execution => execution.StartedAtMs)
            .FirstOrDefaultAsync(cancellationToken);
        if (activeExecution is not null && (activeExecution.Status != TaskExecutionStatus.Recovering || activeExecution.DeviceId != deviceId))
        {
            return new(DeviceOperationStatus.Conflict, Detail: "The task already has an active execution.");
        }

        task.Assign(leaseOwner, checked(nowMs + LeaseDurationMs), nowMs, deviceId);
        task.Start(nowMs);
        var execution = activeExecution;
        if (execution is null)
        {
            execution = TaskExecution.Create(Guid.CreateVersion7(), task.Id, deviceId, task.WorkerKind, nowMs);
            execution.Start(nowMs);
            db.TaskExecutions.Add(execution);
        }
        else
        {
            execution.ResumeFromRecovery(nowMs);
        }
        execution.SetMetadata(JsonSerializer.Serialize(effectiveEnvelope, JsonOptions));
        AddTaskEvent(task, "task.claimed", nowMs, deviceId, execution.Id, null);
        var response = new DeviceTaskClaimResponse(
            true,
            ToTaskResponse(task, execution),
            ToExecutionResponse(execution),
            leaseOwner,
            task.LeaseExpiresAtMs,
            effectiveEnvelope);
        AddIdempotency(device.UserId, $"devices:{deviceId:D}:{scopeSuffix}", idempotencyKey, requestHash, 200, response, nowMs);
        await db.SaveChangesAsync(cancellationToken);
        await transaction.CommitAsync(cancellationToken);
        return new(DeviceOperationStatus.Succeeded, response);
    }

    public async Task<DeviceOperation<DeviceActiveTaskListResponse>> ListActiveAsync(
        Guid deviceId,
        CancellationToken cancellationToken)
    {
        var nowMs = Now();
        var device = await db.Devices.AsNoTracking().SingleOrDefaultAsync(item => item.Id == deviceId, cancellationToken);
        if (device is null
            || device.Status != DeviceStatus.Online
            || device.LastSeenAtMs is not long lastSeenAtMs
            || lastSeenAtMs <= nowMs - DeviceHeartbeatFreshnessMs)
        {
            return new(DeviceOperationStatus.Unauthorized, Detail: "The device must have a recent heartbeat before recovering work.");
        }

        var tasks = await db.Tasks.AsNoTracking()
            .Where(task => task.AssignedDeviceId == deviceId
                && task.LeaseExpiresAtMs != null
                && task.LeaseExpiresAtMs > nowMs
                && (task.Status == DomainTaskStatus.Assigned
                    || task.Status == DomainTaskStatus.Running
                    || task.Status == DomainTaskStatus.WaitingForApproval
                    || task.Status == DomainTaskStatus.CancellationRequested))
            .OrderBy(task => task.CreatedAtMs)
            .ToListAsync(cancellationToken);
        if (tasks.Count == 0)
        {
            return new(DeviceOperationStatus.Succeeded, new DeviceActiveTaskListResponse([]));
        }

        var taskIds = tasks.Select(task => task.Id).ToArray();
        var executions = await db.TaskExecutions.AsNoTracking()
            .Where(execution => taskIds.Contains(execution.TaskId)
                && execution.DeviceId == deviceId
                && execution.Status != TaskExecutionStatus.Succeeded
                && execution.Status != TaskExecutionStatus.Failed
                && execution.Status != TaskExecutionStatus.Cancelled)
            .OrderByDescending(execution => execution.StartedAtMs)
            .ToListAsync(cancellationToken);
        var items = tasks
            .Select(task => (task, execution: executions.FirstOrDefault(execution => execution.TaskId == task.Id)))
            .Where(item => item.execution is not null && !string.IsNullOrWhiteSpace(item.task.LeaseOwner))
            .Select(item => new DeviceTaskClaimResponse(
                true,
                ToTaskResponse(item.task, item.execution),
                ToExecutionResponse(item.execution!),
                item.task.LeaseOwner,
                item.task.LeaseExpiresAtMs,
                DeserializeCapabilityEnvelope(item.execution!.MetadataJson)))
            .ToArray();
        return new(DeviceOperationStatus.Succeeded, new DeviceActiveTaskListResponse(items));
    }

    public async Task<DeviceOperation<DeviceTaskLeaseRenewResponse>> RenewLeaseAsync(
        Guid deviceId,
        Guid taskId,
        DeviceTaskLeaseRenewRequest request,
        string? idempotencyKey,
        CancellationToken cancellationToken)
    {
        if (string.IsNullOrWhiteSpace(idempotencyKey) || idempotencyKey.Length > 200)
        {
            return Invalid<DeviceTaskLeaseRenewResponse>("The Idempotency-Key header is required.");
        }

        var task = await db.Tasks.SingleOrDefaultAsync(item => item.Id == taskId && item.AssignedDeviceId == deviceId, cancellationToken);
        if (task is null)
        {
            return new(DeviceOperationStatus.NotFound, Detail: "Task not found for this device.");
        }

        var requestHash = Hash(request);
        var scope = $"devices:{deviceId:D}:tasks:{taskId:D}:lease-renew";
        var existing = await FindIdempotencyAsync(task.UserId, scope, idempotencyKey, cancellationToken);
        if (existing is not null)
        {
            return Replay<DeviceTaskLeaseRenewResponse>(existing, requestHash, json => JsonSerializer.Deserialize<DeviceTaskLeaseRenewResponse>(json, JsonOptions));
        }

        var nowMs = Now();
        var renewed = task.RenewLease(request.LeaseOwner, checked(nowMs + LeaseDurationMs), nowMs);
        if (!renewed)
        {
            return new(DeviceOperationStatus.Conflict, new DeviceTaskLeaseRenewResponse(task.Id, false, task.LeaseExpiresAtMs, ToContractStatus(task.Status)), "The lease is not owned or has expired.");
        }

        var response = new DeviceTaskLeaseRenewResponse(task.Id, true, task.LeaseExpiresAtMs, ToContractStatus(task.Status));
        AddIdempotency(task.UserId, scope, idempotencyKey, requestHash, 200, response, nowMs);
        await db.SaveChangesAsync(cancellationToken);
        return new(DeviceOperationStatus.Succeeded, response);
    }

    public async Task<DeviceOperation<TaskResponse>> GetTaskAsync(Guid deviceId, Guid taskId, CancellationToken cancellationToken)
    {
        var task = await db.Tasks.AsNoTracking()
            .SingleOrDefaultAsync(item => item.Id == taskId && item.AssignedDeviceId == deviceId, cancellationToken);
        if (task is null)
        {
            return new(DeviceOperationStatus.NotFound, Detail: "Task not found for this device.");
        }

        var execution = await db.TaskExecutions.AsNoTracking()
            .Where(item => item.TaskId == taskId && item.DeviceId == deviceId)
            .OrderByDescending(item => item.StartedAtMs)
            .FirstOrDefaultAsync(cancellationToken);
        return new(DeviceOperationStatus.Succeeded, ToTaskResponse(task, execution));
    }

    public async Task<DeviceOperation<DeviceTaskEventResponse>> AppendEventAsync(
        Guid deviceId,
        Guid taskId,
        DeviceTaskEventRequest request,
        string? leaseOwner,
        string? idempotencyKey,
        CancellationToken cancellationToken)
    {
        if (string.IsNullOrWhiteSpace(idempotencyKey) || idempotencyKey.Length > 200)
        {
            return Invalid<DeviceTaskEventResponse>("The Idempotency-Key header is required.");
        }

        var device = await db.Devices.AsNoTracking().SingleOrDefaultAsync(item => item.Id == deviceId, cancellationToken);
        if (device is null || device.Status == DeviceStatus.Disabled)
        {
            return new(DeviceOperationStatus.Unauthorized, Detail: "The device is not enabled.");
        }

        var requestHash = Hash(request);
        var scope = $"devices:{deviceId:D}:tasks:{taskId:D}:event";
        var existingIdempotency = await FindIdempotencyAsync(device.UserId, scope, idempotencyKey, cancellationToken);
        if (existingIdempotency is not null)
        {
            return Replay<DeviceTaskEventResponse>(existingIdempotency, requestHash, json => JsonSerializer.Deserialize<DeviceTaskEventResponse>(json, JsonOptions));
        }

        await using var transaction = await db.Database.BeginTransactionAsync(IsolationLevel.Serializable, cancellationToken);
        var existing = await db.TaskEvents.AsNoTracking().SingleOrDefaultAsync(item =>
            item.TaskId == taskId && item.DeviceId == deviceId && item.ClientEventId == request.ClientEventId, cancellationToken);
        if (existing is not null)
        {
            if (!string.Equals(existing.EventType, request.EventType, StringComparison.Ordinal)
                || !string.Equals(existing.PayloadJson, request.PayloadJson ?? "{}", StringComparison.Ordinal)
                || existing.ExecutionId != request.ExecutionId)
            {
                return new(DeviceOperationStatus.Conflict, Detail: "ClientEventId was already used with a different event.");
            }

            var existingTask = await db.Tasks.AsNoTracking().SingleOrDefaultAsync(item => item.Id == taskId, cancellationToken);
            var existingExecution = await db.TaskExecutions.AsNoTracking().SingleOrDefaultAsync(item => item.Id == request.ExecutionId, cancellationToken);
            if (existingTask is null || existingExecution is null)
            {
                return new(DeviceOperationStatus.NotFound, Detail: "The original task event execution no longer exists.");
            }

            var replayResponse = new DeviceTaskEventResponse(taskId, request.ExecutionId, true, true, ToContractStatus(existingTask.Status), ToContractStatus(existingExecution.Status));
            AddIdempotency(device.UserId, scope, idempotencyKey, requestHash, 200, replayResponse, Now());
            await db.SaveChangesAsync(cancellationToken);
            await transaction.CommitAsync(cancellationToken);
            return new(DeviceOperationStatus.Replayed, replayResponse);
        }

        var task = await db.Tasks.SingleOrDefaultAsync(item => item.Id == taskId && item.AssignedDeviceId == deviceId, cancellationToken);
        var execution = await db.TaskExecutions.SingleOrDefaultAsync(item => item.Id == request.ExecutionId && item.TaskId == taskId && item.DeviceId == deviceId, cancellationToken);
        if (task is null || execution is null)
        {
            return new(DeviceOperationStatus.NotFound, Detail: "The task execution is not owned by this device.");
        }

        var nowMs = Now();
        if (!string.Equals(task.LeaseOwner, leaseOwner, StringComparison.Ordinal)
            || task.LeaseExpiresAtMs is not long expiresAtMs
            || expiresAtMs <= nowMs)
        {
            return new(DeviceOperationStatus.Conflict, Detail: "The task lease has expired.");
        }

        if (task.Status is DomainTaskStatus.Succeeded or DomainTaskStatus.Failed or DomainTaskStatus.Cancelled)
        {
            return new(DeviceOperationStatus.Conflict, Detail: "A terminal task cannot receive another event.");
        }

        var sequence = (await db.TaskEvents.Where(item => item.TaskId == taskId).Select(item => (long?)item.Sequence).MaxAsync(cancellationToken) ?? 0L) + 1L;
        var payload = request.PayloadJson ?? "{}";
        if (request.Artifacts is { Count: > 0 })
        {
            var policy = BuildExecutionPolicy(execution.MetadataJson);
            if (policy is null)
            {
                return Invalid<DeviceTaskEventResponse>("The execution capability envelope is missing or invalid.");
            }

            if (!ArtifactManifestValidator.TryValidateDeclaration(policy, request.Artifacts, out var artifactError))
            {
                return Invalid<DeviceTaskEventResponse>(artifactError);
            }
        }
        if (string.Equals(request.EventType, "codex.turn.starting", StringComparison.Ordinal))
        {
            if (string.IsNullOrWhiteSpace(request.CodexThreadId) || request.CodexTurnId is not null)
            {
                return Invalid<DeviceTaskEventResponse>("A Codex turn-starting event requires only the thread identifier.");
            }

            if (!execution.MarkCodexTurnStarting(request.CodexThreadId, nowMs))
            {
                return new(DeviceOperationStatus.Conflict, Detail: "The Codex turn-start intent was already recorded.");
            }
        }
        else if (string.Equals(request.EventType, "codex.turn.started", StringComparison.Ordinal))
        {
            if (string.IsNullOrWhiteSpace(request.CodexThreadId)
                || string.IsNullOrWhiteSpace(request.CodexTurnId)
                || execution.CodexTurnStartRequestedAtMs is null
                || !string.Equals(execution.CodexThreadId, request.CodexThreadId, StringComparison.Ordinal))
            {
                return Invalid<DeviceTaskEventResponse>("A Codex turn-started event must complete the persisted start intent for the same thread.");
            }

            execution.SetCodexTurn(request.CodexThreadId, request.CodexTurnId);
        }
        else if (request.CodexThreadId is not null || request.CodexTurnId is not null)
        {
            return Invalid<DeviceTaskEventResponse>("Codex identifiers are only valid on Codex turn lifecycle events.");
        }
        db.TaskEvents.Add(DomainTaskEvent.Create(Guid.CreateVersion7(), taskId, sequence, request.EventType, payload, nowMs, deviceId, execution.Id, request.ClientEventId));
        DeviceTaskEventResponse response;
        if (request.ResultSummary is not null)
        {
            task.MarkSucceeded(request.ResultSummary, nowMs, request.ResultPayloadJson);
            execution.MarkSucceeded(request.ResultPayloadJson, JsonSerializer.Serialize(request.Artifacts ?? Array.Empty<ArtifactManifestEntry>(), JsonOptions), nowMs);
            AddTerminalNotification(task, "task.completed", NotificationSeverity.Success, "后台任务已完成", request.ResultSummary, nowMs);
        }
        else if (request.ProgressSummary is not null)
        {
            task.MarkProgress(request.ProgressSummary, nowMs);
        }
        else if (string.Equals(request.EventType, "task.recovering", StringComparison.OrdinalIgnoreCase))
        {
            task.MarkRecovering(nowMs, preserveLease: true);
            execution.MarkRecovering(nowMs);
            var pendingApprovals = await db.Approvals
                .Where(item => item.TaskId == taskId && item.Status == ApprovalStatus.Pending)
                .ToListAsync(cancellationToken);
            foreach (var pendingApproval in pendingApprovals)
            {
                pendingApproval.Cancel(nowMs);
            }
        }
        else if (string.Equals(request.EventType, "codex.turn.started", StringComparison.OrdinalIgnoreCase)
            && task.Status == DomainTaskStatus.Recovering
            && execution.Status == TaskExecutionStatus.Recovering)
        {
            task.ResumeFromRecovery(nowMs);
            execution.ResumeFromRecovery(nowMs);
        }
        else if (string.Equals(request.EventType, "task.failed", StringComparison.OrdinalIgnoreCase))
        {
            task.MarkFailed(
                request.ErrorCode ?? "device_execution_failed",
                request.ErrorMessage ?? "The Device Node execution failed.",
                nowMs);
            execution.MarkFailed(request.PayloadJson ?? "{\"reason\":\"device_execution_failed\"}", nowMs);
            AddTerminalNotification(task, "task.failed", NotificationSeverity.Error, "后台任务执行失败", request.ErrorMessage ?? "The Device Node execution failed.", nowMs);
        }
        else if (string.Equals(request.EventType, "task.cancelled", StringComparison.OrdinalIgnoreCase)
            && task.Status == DomainTaskStatus.CancellationRequested)
        {
            task.ConfirmCancellation(nowMs);
            execution.MarkCancelled(nowMs);
            AddTerminalNotification(task, "task.cancelled", NotificationSeverity.Info, "后台任务已取消", "The device confirmed cancellation.", nowMs);
        }

        AddOutbox("task.updated", new
        {
            userId = task.UserId,
            deviceId,
            taskId,
            executionId = execution.Id,
            status = JsonNamingPolicy.CamelCase.ConvertName(task.Status.ToString()),
            eventType = request.EventType,
            occurredAt = nowMs,
            entityVersion = task.Version
        }, nowMs);
        response = new DeviceTaskEventResponse(taskId, execution.Id, true, false, ToContractStatus(task.Status), ToContractStatus(execution.Status));
        AddIdempotency(device.UserId, scope, idempotencyKey, requestHash, 200, response, nowMs);
        await db.SaveChangesAsync(cancellationToken);
        await transaction.CommitAsync(cancellationToken);
        return new(DeviceOperationStatus.Succeeded, response);
    }

    public async Task<DeviceOperation<DeviceApprovalResponse>> CreateApprovalAsync(
        Guid deviceId,
        Guid taskId,
        DeviceApprovalRequest request,
        string? leaseOwner,
        string? idempotencyKey,
        CancellationToken cancellationToken)
    {
        if (string.IsNullOrWhiteSpace(idempotencyKey) || idempotencyKey.Length > 200)
        {
            return Invalid<DeviceApprovalResponse>("The Idempotency-Key header is required.");
        }

        var device = await db.Devices.AsNoTracking().SingleOrDefaultAsync(item => item.Id == deviceId, cancellationToken);
        if (device is null || device.Status == DeviceStatus.Disabled)
        {
            return new(DeviceOperationStatus.Unauthorized, Detail: "The device is not enabled.");
        }

        var requestHash = Hash(request);
        var scope = $"devices:{deviceId:D}:tasks:{taskId:D}:approval";
        var existingIdempotency = await FindIdempotencyAsync(device.UserId, scope, idempotencyKey, cancellationToken);
        if (existingIdempotency is not null)
        {
            return Replay<DeviceApprovalResponse>(existingIdempotency, requestHash, json => JsonSerializer.Deserialize<DeviceApprovalResponse>(json, JsonOptions));
        }

        await using var transaction = await db.Database.BeginTransactionAsync(IsolationLevel.Serializable, cancellationToken);
        var task = await db.Tasks.SingleOrDefaultAsync(item => item.Id == taskId && item.AssignedDeviceId == deviceId, cancellationToken);
        var execution = await db.TaskExecutions.SingleOrDefaultAsync(item => item.Id == request.ExecutionId && item.TaskId == taskId && item.DeviceId == deviceId, cancellationToken);
        if (task is null || execution is null || task.Status != DomainTaskStatus.Running || task.LeaseExpiresAtMs is not long expiresAtMs || expiresAtMs <= Now() || !string.Equals(task.LeaseOwner, leaseOwner, StringComparison.Ordinal))
        {
            return new(DeviceOperationStatus.Conflict, Detail: "The task execution is not active for this device.");
        }

        if (!string.IsNullOrWhiteSpace(request.RequestId))
        {
            var replay = await db.Approvals.AsNoTracking().SingleOrDefaultAsync(item => item.DeviceId == deviceId && item.RequestId == request.RequestId, cancellationToken);
            if (replay is not null)
            {
                if (replay.ExecutionId != request.ExecutionId
                    || replay.Kind != ToDomainApprovalKind(request.Kind)
                    || !string.Equals(replay.Reason, request.Reason, StringComparison.Ordinal)
                    || !string.Equals(replay.RequestedActionJson, request.RequestedActionJson, StringComparison.Ordinal))
                {
                    return new(DeviceOperationStatus.Conflict, Detail: "RequestId was already used with a different approval.");
                }

                var replayResponse = new DeviceApprovalResponse(replay.Id, ToContractStatus(replay.Status));
                AddIdempotency(device.UserId, scope, idempotencyKey, requestHash, 200, replayResponse, Now());
                await db.SaveChangesAsync(cancellationToken);
                await transaction.CommitAsync(cancellationToken);
                return new(DeviceOperationStatus.Replayed, replayResponse);
            }
        }

        var nowMs = Now();
        if (request.ExpiresAtMs is long requestedExpiry
            && (requestedExpiry <= nowMs || requestedExpiry > checked(nowMs + ApprovalLifetimeMs)))
        {
            return Invalid<DeviceApprovalResponse>("Approval expiry must be in the future and no more than five minutes away.");
        }

        var approval = Approval.Create(
            Guid.CreateVersion7(),
            task.Id,
            execution.Id,
            deviceId,
            request.RequestId,
            ToDomainApprovalKind(request.Kind),
            request.Reason,
            request.RequestedActionJson,
            null,
            nowMs,
            request.ExpiresAtMs ?? checked(nowMs + ApprovalLifetimeMs));
        task.WaitForApproval(nowMs);
        execution.WaitForApproval(nowMs);
        db.Approvals.Add(approval);
        AddTaskEvent(task, "approval.required", nowMs, deviceId, execution.Id, null);
        AddTerminalNotification(task, "approval.required", NotificationSeverity.Warning, "需要批准后台操作", request.Reason, nowMs, approval.Id);
        AddOutbox("approval.required", new
        {
            userId = task.UserId,
            deviceId,
            taskId,
            executionId = execution.Id,
            approvalId = approval.Id,
            occurredAt = nowMs,
            entityVersion = task.Version
        }, nowMs);
        var response = new DeviceApprovalResponse(approval.Id, ApprovalStatusValue.Pending);
        AddIdempotency(device.UserId, scope, idempotencyKey, requestHash, 201, response, nowMs);
        await db.SaveChangesAsync(cancellationToken);
        await transaction.CommitAsync(cancellationToken);
        return new(DeviceOperationStatus.Succeeded, response);
    }

    public async Task<ApprovalListResponse> ListPendingAsync(Guid userId, CancellationToken cancellationToken)
    {
        var nowMs = Now();
        var approvals = await db.Approvals.AsNoTracking()
            .Join(db.Tasks.AsNoTracking(), approval => approval.TaskId, task => task.Id, (approval, task) => new { approval, task })
            .Where(item => item.task.UserId == userId && item.approval.Status == ApprovalStatus.Pending && (item.approval.ExpiresAtMs == null || item.approval.ExpiresAtMs > nowMs))
            .OrderBy(item => item.approval.CreatedAtMs)
            .Select(item => ToApprovalResponse(item.approval))
            .ToListAsync(cancellationToken);
        return new ApprovalListResponse(approvals);
    }

    public async Task<DeviceOperation<DeviceApprovalStatusResponse>> GetApprovalAsync(
        Guid deviceId,
        Guid taskId,
        Guid approvalId,
        CancellationToken cancellationToken)
    {
        var approval = await db.Approvals.AsNoTracking().SingleOrDefaultAsync(
            item => item.Id == approvalId && item.TaskId == taskId && item.DeviceId == deviceId,
            cancellationToken);
        if (approval is null || approval.ExecutionId is not Guid executionId)
        {
            return new(DeviceOperationStatus.NotFound, Detail: "Approval not found for this device.");
        }

        return new(DeviceOperationStatus.Succeeded, new DeviceApprovalStatusResponse(
            approval.Id,
            approval.TaskId,
            executionId,
            approval.DeviceId,
            ToContractStatus(approval.Status),
            approval.Decision is ApprovalDecision decision ? (ApprovalDecisionValue?)decision : null,
            ToContractScope(approval.Scope)));
    }

    public async Task<ApprovalOperation<ApprovalResponse>> DecideAsync(
        Guid userId,
        Guid approvalId,
        ApprovalDecisionRequest request,
        string? idempotencyKey,
        CancellationToken cancellationToken)
    {
        if (string.IsNullOrWhiteSpace(idempotencyKey) || idempotencyKey.Length > 200)
        {
            return new(ApprovalOperationStatus.Invalid, Detail: "The Idempotency-Key header is required.");
        }

        var requestHash = Hash(request);
        var scope = $"approvals:{approvalId:D}:decision";
        var existingIdempotency = await FindIdempotencyAsync(userId, scope, idempotencyKey, cancellationToken);
        if (existingIdempotency is not null)
        {
            return ReplayApproval(existingIdempotency, requestHash);
        }

        await using var transaction = await db.Database.BeginTransactionAsync(IsolationLevel.Serializable, cancellationToken);
        var approval = await db.Approvals.SingleOrDefaultAsync(item => item.Id == approvalId, cancellationToken);
        if (approval is null)
        {
            return new(ApprovalOperationStatus.NotFound);
        }

        var task = await db.Tasks.SingleOrDefaultAsync(item => item.Id == approval.TaskId && item.UserId == userId, cancellationToken);
        var execution = approval.ExecutionId is Guid executionId
            ? await db.TaskExecutions.SingleOrDefaultAsync(item => item.Id == executionId, cancellationToken)
            : null;
        if (task is null || execution is null)
        {
            return new(ApprovalOperationStatus.NotFound);
        }

        var requestedScope = ToDomainApprovalScope(request.Scope);
        if (approval.Status != ApprovalStatus.Pending && approval.Scope != requestedScope)
        {
            return new(ApprovalOperationStatus.Conflict, Detail: "The requested approval scope does not match the server-bound scope.");
        }

        var nowMs = Now();
        if (approval.Status == ApprovalStatus.Pending && approval.ExpiresAtMs is long expiresAtMs && expiresAtMs <= nowMs)
        {
            approval.Expire(nowMs);
            task.MarkApprovalFailed("approval_expired", "The approval expired before a decision was recorded.", nowMs);
            execution.MarkFailed("{\"reason\":\"approval_expired\"}", nowMs);
            AddTaskEvent(task, "approval.expired", nowMs, approval.DeviceId, execution.Id, null);
            AddTerminalNotification(task, "task.failed", NotificationSeverity.Error, "后台任务审批已过期", "The approval expired before a decision was recorded.", nowMs);
            var expiredResponse = ToApprovalResponse(approval);
            AddApprovalIdempotency(userId, scope, idempotencyKey, requestHash, 409, expiredResponse, nowMs);
            await db.SaveChangesAsync(cancellationToken);
            await transaction.CommitAsync(cancellationToken);
            return new(ApprovalOperationStatus.Conflict, expiredResponse, "The approval has expired.");
        }

        var decision = request.Decision == ApprovalDecisionValue.Approve ? ApprovalDecision.Approved : ApprovalDecision.Denied;
        if (approval.Status != ApprovalStatus.Pending)
        {
            if (approval.Decision != decision)
            {
                return new(ApprovalOperationStatus.Conflict, ToApprovalResponse(approval), "An approval cannot be changed after it has been decided.");
            }

            var replayResponse = ToApprovalResponse(approval);
            AddApprovalIdempotency(userId, scope, idempotencyKey, requestHash, 200, replayResponse, nowMs);
            await db.SaveChangesAsync(cancellationToken);
            await transaction.CommitAsync(cancellationToken);
            return new(ApprovalOperationStatus.Replayed, replayResponse);
        }

        if (!approval.Decide(decision, requestedScope, approval.DeviceId, nowMs))
        {
            return new(ApprovalOperationStatus.Replayed, ToApprovalResponse(approval));
        }

        if (decision == ApprovalDecision.Approved)
        {
            task.Resume(nowMs);
            execution.Resume(nowMs);
        }
        else
        {
            task.MarkApprovalFailed("approval_denied", "The requested operation was denied.", nowMs);
            execution.MarkFailed("{\"reason\":\"approval_denied\"}", nowMs);
            AddTerminalNotification(task, "task.failed", NotificationSeverity.Warning, "后台任务已拒绝", "The requested operation was denied.", nowMs);
        }

        var notification = await db.Notifications.SingleOrDefaultAsync(item => item.ApprovalId == approval.Id, cancellationToken);
        notification?.MarkActioned(nowMs);
        AddTaskEvent(task, decision == ApprovalDecision.Approved ? "approval.approved" : "approval.denied", nowMs, approval.DeviceId, execution.Id, null);
        AddOutbox("approval.resolved", new
        {
            userId,
            deviceId = approval.DeviceId,
            taskId = task.Id,
            executionId = execution.Id,
            approvalId = approval.Id,
            decision = request.Decision == ApprovalDecisionValue.Approve ? "approve" : "deny",
            occurredAt = nowMs,
            entityVersion = task.Version
        }, nowMs);
        var response = ToApprovalResponse(approval);
        AddApprovalIdempotency(userId, scope, idempotencyKey, requestHash, 200, response, nowMs);
        await db.SaveChangesAsync(cancellationToken);
        await transaction.CommitAsync(cancellationToken);
        return new(ApprovalOperationStatus.Succeeded, response);
    }

    private static DeviceOperation<T> Invalid<T>(string detail) => new(DeviceOperationStatus.Invalid, Detail: detail);

    private void AddApprovalIdempotency(Guid userId, string scope, string key, string requestHash, int status, ApprovalResponse response, long nowMs)
    {
        AddIdempotency(userId, scope, key, requestHash, status, response, nowMs);
    }

    private static ApprovalOperation<ApprovalResponse> ReplayApproval(IdempotencyRecord existing, string requestHash)
    {
        if (!string.Equals(existing.RequestHash, requestHash, StringComparison.Ordinal))
        {
            return new(ApprovalOperationStatus.Conflict, Detail: "The Idempotency-Key was already used with a different payload.");
        }

        var value = JsonSerializer.Deserialize<ApprovalResponse>(existing.ResponseJson, JsonOptions);
        return value is null
            ? new(ApprovalOperationStatus.Conflict, Detail: "The stored approval response could not be read.")
            : new(ApprovalOperationStatus.Replayed, value);
    }

    private long Now() => timeProvider.GetUtcNow().ToUnixTimeMilliseconds();

    private static string[] NormalizeCapabilities(IReadOnlyList<string>? capabilities) => (capabilities ?? Array.Empty<string>())
        .Where(value => !string.IsNullOrWhiteSpace(value))
        .Select(value => value.Trim())
        .Distinct(StringComparer.Ordinal)
        .ToArray();

    private static string[] NormalizeAllowedRoots(IReadOnlyList<string>? roots)
    {
        var policy = CapabilityPolicy.Create(new CapabilityEnvelope(ReadFiles: true, WriteFiles: true, AllowedRoots: roots ?? Array.Empty<string>()));
        return policy.AllowedRoots.ToArray();
    }

    private static string[] IntersectAllowedRoots(
        string[]? leftRoots,
        IReadOnlyList<string>? rightRoots)
    {
        if (leftRoots is null || leftRoots.Length == 0 || rightRoots is null || rightRoots.Count == 0)
        {
            return [];
        }

        var normalizedLeft = NormalizeAllowedRoots(leftRoots);
        var normalizedRight = NormalizeAllowedRoots(rightRoots);
        var leftPolicy = CapabilityPolicy.Create(new CapabilityEnvelope(
            ReadFiles: true,
            WriteFiles: true,
            AllowedRoots: normalizedLeft));
        var rightPolicy = CapabilityPolicy.Create(new CapabilityEnvelope(
            ReadFiles: true,
            WriteFiles: true,
            AllowedRoots: normalizedRight));
        return normalizedLeft
            .SelectMany(left => normalizedRight.Select(right => (left, right)))
            .Select(pair => leftPolicy.IsAllowedPath(pair.right, write: false)
                ? pair.right
                : rightPolicy.IsAllowedPath(pair.left, write: false)
                    ? pair.left
                    : null)
            .Where(root => root is not null)
            .Select(root => root!)
            .Distinct(StringComparer.Ordinal)
            .ToArray();
    }

    private static CapabilityEnvelopeContract BuildEffectiveEnvelope(
        Device device,
        CapabilityEnvelopeContract? taskEnvelope,
        CapabilityEnvelopeContract? requested)
    {
        var deviceCapabilities = DeserializeList(device.CapabilitiesJson);
        var deviceAndRequestRoots = IntersectAllowedRoots(
            DeserializeList(device.AllowedRootsJson),
            requested?.AllowedRoots);
        var roots = IntersectAllowedRoots(deviceAndRequestRoots, taskEnvelope?.AllowedRoots);
        return new CapabilityEnvelopeContract(
            ReadFiles: requested?.ReadFiles == true
                && taskEnvelope?.ReadFiles == true
                && deviceCapabilities.Contains("localFiles", StringComparer.Ordinal),
            WriteFiles: requested?.WriteFiles == true
                && taskEnvelope?.WriteFiles == true
                && deviceCapabilities.Contains("writeFiles", StringComparer.Ordinal),
            RunCommands: requested?.RunCommands == true
                && taskEnvelope?.RunCommands == true
                && deviceCapabilities.Contains("runCommands", StringComparer.Ordinal),
            Network: requested?.Network == true
                && taskEnvelope?.Network == true
                && deviceCapabilities.Contains("network", StringComparer.Ordinal),
            AllowedRoots: roots);
    }

    private static CapabilityEnvelopeContract? DeserializeCapabilityEnvelope(string json)
    {
        try
        {
            return JsonSerializer.Deserialize<CapabilityEnvelopeContract>(json, JsonOptions);
        }
        catch (JsonException)
        {
            return null;
        }
    }

    private static CapabilityPolicy? BuildExecutionPolicy(string metadataJson)
    {
        try
        {
            var envelope = JsonSerializer.Deserialize<CapabilityEnvelopeContract>(metadataJson, JsonOptions);
            return envelope is null
                ? null
                : CapabilityPolicy.Create(new CapabilityEnvelope(
                    envelope.ReadFiles,
                    envelope.WriteFiles,
                    envelope.RunCommands,
                    envelope.Network,
                    envelope.AllowedRoots ?? Array.Empty<string>()));
        }
        catch (JsonException)
        {
            return null;
        }
    }

    private static bool DeviceSupports(string deviceCapabilitiesJson, string taskCapabilitiesJson)
    {
        try
        {
            var deviceCapabilities = JsonSerializer.Deserialize<string[]>(deviceCapabilitiesJson, JsonOptions) ?? Array.Empty<string>();
            var required = JsonSerializer.Deserialize<string[]>(taskCapabilitiesJson, JsonOptions) ?? Array.Empty<string>();
            return required.All(capability => deviceCapabilities.Contains(capability, StringComparer.Ordinal));
        }
        catch (JsonException)
        {
            return false;
        }
    }

    private static bool EnvelopeSupports(CapabilityEnvelopeContract? envelope, string taskCapabilitiesJson)
    {
        if (envelope is null)
        {
            return true;
        }

        try
        {
            var required = JsonSerializer.Deserialize<string[]>(taskCapabilitiesJson, JsonOptions) ?? Array.Empty<string>();
            foreach (var capability in required)
            {
                if (string.Equals(capability, "localFiles", StringComparison.Ordinal)
                    && (!envelope.ReadFiles || envelope.AllowedRoots is not { Count: > 0 }))
                {
                    return false;
                }

                if (string.Equals(capability, "writeFiles", StringComparison.Ordinal)
                    && (!envelope.ReadFiles || !envelope.WriteFiles || envelope.AllowedRoots is not { Count: > 0 }))
                {
                    return false;
                }

                if (string.Equals(capability, "runCommands", StringComparison.Ordinal)
                    && (!envelope.ReadFiles || !envelope.RunCommands || envelope.AllowedRoots is not { Count: > 0 }))
                {
                    return false;
                }

                if (string.Equals(capability, "network", StringComparison.Ordinal) && !envelope.Network)
                {
                    return false;
                }
            }

            return true;
        }
        catch (JsonException)
        {
            return false;
        }
    }

    private async Task<IdempotencyRecord?> FindIdempotencyAsync(Guid userId, string scope, string key, CancellationToken cancellationToken)
    {
        var nowMs = Now();
        return await db.IdempotencyRecords.AsNoTracking().SingleOrDefaultAsync(item => item.UserId == userId && item.Scope == scope && item.IdempotencyKey == key && item.ExpiresAtMs > nowMs, cancellationToken);
    }

    private void AddIdempotency<T>(Guid userId, string scope, string key, string requestHash, int status, T response, long nowMs)
    {
        db.IdempotencyRecords.Add(IdempotencyRecord.Create(userId, scope, key, requestHash, status, JsonSerializer.Serialize(response, JsonOptions), nowMs, checked(nowMs + idempotencyOptions.Value.RetentionMs)));
    }

    private static DeviceOperation<T> Replay<T>(IdempotencyRecord existing, string requestHash, Func<string, T?> deserialize)
    {
        if (!string.Equals(existing.RequestHash, requestHash, StringComparison.Ordinal))
        {
            return new(DeviceOperationStatus.Conflict, Detail: "The Idempotency-Key was already used with a different payload.");
        }

        var value = deserialize(existing.ResponseJson);
        return value is null ? new(DeviceOperationStatus.Conflict, Detail: "The stored response could not be read.") : new(DeviceOperationStatus.Replayed, value);
    }

    private static string Hash<T>(T value) => Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(JsonSerializer.Serialize(value, JsonOptions))));

    private static string HashCredential(string credential) => Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(credential)));

    private void AddTaskEvent(DomainTask task, string eventType, long nowMs, Guid? deviceId, Guid? executionId, string? clientEventId)
    {
        var sequence = (db.TaskEvents.Where(item => item.TaskId == task.Id).Select(item => (long?)item.Sequence).Max() ?? 0L) + 1L;
        var payload = JsonSerializer.Serialize(new
        {
            userId = task.UserId,
            deviceId,
            taskId = task.Id,
            executionId,
            eventType,
            status = JsonNamingPolicy.CamelCase.ConvertName(task.Status.ToString()),
            occurredAt = nowMs,
            entityVersion = task.Version
        }, JsonOptions);
        db.TaskEvents.Add(DomainTaskEvent.Create(Guid.CreateVersion7(), task.Id, sequence, eventType, payload, nowMs, deviceId, executionId, clientEventId));
    }

    private void AddTerminalNotification(DomainTask task, string type, NotificationSeverity severity, string title, string body, long nowMs, Guid? approvalId = null)
    {
        var dedupKey = approvalId is Guid id ? $"approval:{id:D}:{type}" : $"task:{task.Id:D}:{type}";
        if (db.Notifications.Any(item => item.UserId == task.UserId && item.DedupKey == dedupKey))
        {
            return;
        }

        var notification = Notification.Create(Guid.CreateVersion7(), task.UserId, task.ConversationId, task.Id, type, severity, title, body, dedupKey, nowMs, approvalId);
        db.Notifications.Add(notification);
        AddOutbox("notification.created", new
        {
            userId = task.UserId,
            notificationId = notification.Id,
            taskId = task.Id,
            approvalId,
            conversationId = task.ConversationId,
            type,
            severity = JsonNamingPolicy.CamelCase.ConvertName(severity.ToString()),
            title,
            body,
            status = "pending",
            dedupKey,
            entityVersion = notification.Version
        }, nowMs);
    }

    private void AddOutbox(string eventType, object payload, long nowMs)
    {
        var id = Guid.CreateVersion7();
        db.OutboxMessages.Add(OutboxMessage.Create(id, eventType, JsonSerializer.Serialize(new { eventId = id, occurredAt = nowMs, type = eventType, payload }, JsonOptions), nowMs));
        JarvisTelemetry.RecordOutboxEnqueued(eventType);
    }

    private static TaskResponse ToTaskResponse(DomainTask task, TaskExecution? execution = null) => new(
        task.Id,
        task.ConversationId,
        task.CreatedByMessageId,
        task.Goal,
        task.ExpectedOutput,
        DeserializeList(task.RequiredCapabilitiesJson),
        DeserializeList(task.AttachmentRefsJson),
        task.PreferredDeviceId,
        task.AssignedDeviceId,
        ToContractWorker(task.WorkerKind),
        ToContractStatus(task.Status),
        task.Priority,
        task.Attempt,
        task.ProgressSummary,
        task.ResultSummary,
        task.ResultPayloadJson,
        task.ErrorCode,
        task.ErrorMessage,
        task.Version,
        task.CreatedAtMs,
        task.StartedAtMs,
        task.CompletedAtMs,
        execution is null ? null : ToExecutionResponse(execution),
        execution is null ? Array.Empty<ArtifactManifestEntry>() : DeserializeArtifacts(execution.ArtifactManifestJson),
        DeserializeCapabilityEnvelope(task.CapabilityEnvelopeJson));

    private static TaskExecutionResponse ToExecutionResponse(TaskExecution execution) => new(
        execution.Id,
        execution.TaskId,
        execution.DeviceId,
        ToContractWorker(execution.WorkerKind),
        execution.ExternalExecutionId,
        execution.CodexThreadId,
        execution.CodexTurnId,
        ToContractStatus(execution.Status),
        execution.MetadataJson,
        execution.ResultPayloadJson,
        DeserializeArtifacts(execution.ArtifactManifestJson),
        execution.StartedAtMs,
        execution.EndedAtMs,
        execution.Version,
        execution.CodexTurnStartRequestedAtMs);

    private static ApprovalResponse ToApprovalResponse(Approval approval) => new(
        approval.Id,
        approval.TaskId,
        approval.ExecutionId,
        approval.DeviceId,
        ToContractKind(approval.Kind),
        approval.Reason,
        ToContractStatus(approval.Status),
        ToContractScope(approval.Scope),
        approval.RequestId,
        approval.DecidedByDeviceId,
        approval.CreatedAtMs,
        approval.DecidedAtMs,
        approval.ExpiresAtMs,
        approval.Version);

    private static string[] DeserializeList(string json)
    {
        try { return JsonSerializer.Deserialize<string[]>(json, JsonOptions) ?? Array.Empty<string>(); }
        catch (JsonException) { return Array.Empty<string>(); }
    }

    private static ArtifactManifestEntry[] DeserializeArtifacts(string json)
    {
        try { return JsonSerializer.Deserialize<ArtifactManifestEntry[]>(json, JsonOptions) ?? Array.Empty<ArtifactManifestEntry>(); }
        catch (JsonException) { return Array.Empty<ArtifactManifestEntry>(); }
    }

    private static DeviceType ToDomainDeviceType(DeviceTypeValue value) => (DeviceType)value;
    private static DeviceTypeValue ToContractDeviceType(DeviceType value) => (DeviceTypeValue)value;
    private static DeviceStatusValue ToContractStatus(DeviceStatus value) => (DeviceStatusValue)value;
    private static TaskStatusValue ToContractStatus(DomainTaskStatus value) => (TaskStatusValue)value;
    private static WorkerKindValue ToContractWorker(WorkerKind value) => (WorkerKindValue)value;
    private static TaskExecutionStatusValue ToContractStatus(TaskExecutionStatus value) => (TaskExecutionStatusValue)value;
    private static ApprovalKind ToDomainApprovalKind(ApprovalKindValue value) => (ApprovalKind)value;
    private static ApprovalKindValue ToContractKind(ApprovalKind value) => (ApprovalKindValue)value;
    private static ApprovalScope ToDomainApprovalScope(ApprovalScopeValue? value) => value is ApprovalScopeValue scope ? (ApprovalScope)scope : throw new InvalidOperationException("Decision scope is required.");
    private static ApprovalScopeValue? ToContractScope(ApprovalScope? value) => value is ApprovalScope scope ? (ApprovalScopeValue)scope : null;
    private static ApprovalStatusValue ToContractStatus(ApprovalStatus value) => (ApprovalStatusValue)value;
}

internal static class DeviceStoreResponseExtensions
{
    public static T? ToNullable<T>(this T value) where T : class => value;
}
