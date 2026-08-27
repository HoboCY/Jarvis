using System.Security.Claims;
using Jarvis.Api.Authentication;
using Jarvis.Application.Devices;
using Jarvis.Application.Tasks;
using Jarvis.Contracts;

namespace Jarvis.Api.Devices;

public static class DeviceEndpoints
{
    public static IEndpointRouteBuilder MapDeviceEndpoints(this IEndpointRouteBuilder endpoints)
    {
        endpoints.MapGet("/api/v1/devices", ListOwnedAsync)
            .RequireAuthorization()
            .WithName("ListDevices")
            .WithSummary("Lists the authenticated user's safe device projections.")
            .Produces<DeviceListResponse>()
            .ProducesProblem(StatusCodes.Status400BadRequest)
            .ProducesProblem(StatusCodes.Status401Unauthorized);

        endpoints.MapPost("/api/v1/devices/register", RegisterAsync)
            .RequireAuthorization(AuthenticationConstants.LocalOnlyPolicy)
            .WithName("RegisterDevice")
            .Produces<DeviceRegistrationResponse>(StatusCodes.Status201Created)
            .ProducesProblem(StatusCodes.Status400BadRequest)
            .ProducesProblem(StatusCodes.Status401Unauthorized)
            .ProducesProblem(StatusCodes.Status409Conflict);

        var devices = endpoints.MapGroup("/api/v1/devices/{deviceId:guid}")
            .RequireAuthorization(AuthenticationConstants.DevicePolicy);
        devices.MapPost("/heartbeat", HeartbeatAsync)
            .WithName("HeartbeatDevice")
            .Produces<DeviceHeartbeatResponse>()
            .ProducesProblem(StatusCodes.Status401Unauthorized)
            .ProducesProblem(StatusCodes.Status403Forbidden)
            .ProducesProblem(StatusCodes.Status404NotFound);

        var tasks = endpoints.MapGroup("/api/v1/device-tasks")
            .RequireAuthorization(AuthenticationConstants.DevicePolicy);
        tasks.MapPost("/claim", ClaimAsync)
            .WithName("ClaimDeviceTask")
            .Produces<DeviceTaskClaimResponse>()
            .ProducesProblem(StatusCodes.Status401Unauthorized)
            .ProducesProblem(StatusCodes.Status409Conflict);
        tasks.MapGet("/active", ListActiveAsync)
            .WithName("ListActiveDeviceTasks")
            .Produces<DeviceActiveTaskListResponse>()
            .ProducesProblem(StatusCodes.Status401Unauthorized)
            .ProducesProblem(StatusCodes.Status403Forbidden);
        tasks.MapPost("/{taskId:guid}/events", AppendEventAsync)
            .WithName("AppendDeviceTaskEvent")
            .Produces<DeviceTaskEventResponse>()
            .ProducesProblem(StatusCodes.Status400BadRequest)
            .ProducesProblem(StatusCodes.Status401Unauthorized)
            .ProducesProblem(StatusCodes.Status404NotFound)
            .ProducesProblem(StatusCodes.Status409Conflict);
        tasks.MapPost("/{taskId:guid}/lease:renew", RenewLeaseAsync)
            .WithName("RenewDeviceTaskLease")
            .Produces<DeviceTaskLeaseRenewResponse>()
            .ProducesProblem(StatusCodes.Status400BadRequest)
            .ProducesProblem(StatusCodes.Status401Unauthorized)
            .ProducesProblem(StatusCodes.Status404NotFound)
            .ProducesProblem(StatusCodes.Status409Conflict);
        tasks.MapPost("/{taskId:guid}/approvals", CreateApprovalAsync)
            .WithName("CreateDeviceApproval")
            .Produces<DeviceApprovalResponse>(StatusCodes.Status201Created)
            .ProducesProblem(StatusCodes.Status400BadRequest)
            .ProducesProblem(StatusCodes.Status401Unauthorized)
            .ProducesProblem(StatusCodes.Status409Conflict);
        tasks.MapPost("/{taskId:guid}/user-input", CreateUserInputAsync)
            .WithName("CreateDeviceTaskUserInput")
            .Produces<DeviceTaskUserInputResponse>(StatusCodes.Status201Created)
            .ProducesProblem(StatusCodes.Status400BadRequest)
            .ProducesProblem(StatusCodes.Status401Unauthorized)
            .ProducesProblem(StatusCodes.Status403Forbidden)
            .ProducesProblem(StatusCodes.Status404NotFound)
            .ProducesProblem(StatusCodes.Status409Conflict);
        tasks.MapGet("/{taskId:guid}/user-input/{requestId}", GetUserInputAsync)
            .WithName("GetDeviceTaskUserInput")
            .Produces<DeviceTaskUserInputResponse>()
            .ProducesProblem(StatusCodes.Status401Unauthorized)
            .ProducesProblem(StatusCodes.Status404NotFound);
        tasks.MapPost("/{taskId:guid}/user-input/{requestId}/resolved", ResolveUserInputAsync)
            .WithName("ResolveDeviceTaskUserInput")
            .Produces<DeviceTaskUserInputResponse>()
            .ProducesProblem(StatusCodes.Status400BadRequest)
            .ProducesProblem(StatusCodes.Status401Unauthorized)
            .ProducesProblem(StatusCodes.Status404NotFound)
            .ProducesProblem(StatusCodes.Status409Conflict);
        tasks.MapGet("/{taskId:guid}", GetTaskAsync)
            .WithName("GetDeviceTask")
            .Produces<TaskResponse>()
            .ProducesProblem(StatusCodes.Status401Unauthorized)
            .ProducesProblem(StatusCodes.Status404NotFound);
        tasks.MapGet("/{taskId:guid}/approvals/{approvalId:guid}", GetApprovalAsync)
            .WithName("GetDeviceApproval")
            .Produces<DeviceApprovalStatusResponse>()
            .ProducesProblem(StatusCodes.Status401Unauthorized)
            .ProducesProblem(StatusCodes.Status404NotFound);
        return endpoints;
    }

    private static async Task<IResult> ListOwnedAsync(
        HttpContext httpContext,
        DeviceCoordinationService service,
        string? deviceType,
        CancellationToken cancellationToken)
    {
        if (!TryGetUserId(httpContext, out var userId))
        {
            return Problem(StatusCodes.Status401Unauthorized, "Unauthorized", "Authentication is required.");
        }

        var result = await service.ListOwnedAsync(userId, deviceType, cancellationToken);
        return result.Status switch
        {
            DeviceOperationStatus.Succeeded => TypedResults.Ok(result.Value),
            DeviceOperationStatus.Invalid => Problem(StatusCodes.Status400BadRequest, "Invalid device filter", result.Detail),
            _ => Problem(StatusCodes.Status500InternalServerError, "Device list failed", "The device list could not be read.")
        };
    }

    private static async Task<IResult> RegisterAsync(
        HttpContext httpContext,
        DeviceCoordinationService service,
        DeviceRegistrationRequest? request,
        CancellationToken cancellationToken)
    {
        if (!TryGetUserId(httpContext, out var userId))
        {
            return Problem(StatusCodes.Status401Unauthorized, "Unauthorized", "Authentication is required.");
        }

        var result = await service.RegisterAsync(userId, request, IdempotencyKey(httpContext), cancellationToken);
        return result.Status switch
        {
            DeviceOperationStatus.Succeeded => Results.Created($"/api/v1/devices/{result.Value!.DeviceId}", result.Value),
            DeviceOperationStatus.Replayed => Results.Ok(result.Value),
            DeviceOperationStatus.Conflict => Problem(StatusCodes.Status409Conflict, "Device registration conflict", result.Detail),
            DeviceOperationStatus.Invalid => Problem(StatusCodes.Status400BadRequest, "Invalid device registration", result.Detail),
            _ => Problem(StatusCodes.Status500InternalServerError, "Device registration failed", result.Detail)
        };
    }

    private static async Task<IResult> HeartbeatAsync(
        Guid deviceId,
        HttpContext httpContext,
        DeviceCoordinationService service,
        DeviceHeartbeatRequest? request,
        CancellationToken cancellationToken)
    {
        if (!OwnsDevice(httpContext, deviceId))
        {
            return Problem(StatusCodes.Status403Forbidden, "Device mismatch", "The credential does not identify this device.");
        }

        var result = await service.HeartbeatAsync(deviceId, request, IdempotencyKey(httpContext), cancellationToken);
        return result.Status switch
        {
            DeviceOperationStatus.Succeeded or DeviceOperationStatus.Replayed => TypedResults.Ok(result.Value),
            DeviceOperationStatus.NotFound => Problem(StatusCodes.Status404NotFound, "Device not found", result.Detail),
            DeviceOperationStatus.Conflict => Problem(StatusCodes.Status409Conflict, "Device conflict", result.Detail),
            DeviceOperationStatus.Invalid => Problem(StatusCodes.Status400BadRequest, "Invalid heartbeat", result.Detail),
            _ => Problem(StatusCodes.Status500InternalServerError, "Heartbeat failed", result.Detail)
        };
    }

    private static async Task<IResult> ClaimAsync(
        HttpContext httpContext,
        DeviceCoordinationService service,
        DeviceTaskClaimRequest? request,
        CancellationToken cancellationToken)
    {
        if (!TryGetDeviceId(httpContext, out var deviceId))
        {
            return Problem(StatusCodes.Status401Unauthorized, "Unauthorized", "A device credential is required.");
        }

        var result = await service.ClaimAsync(deviceId, request, IdempotencyKey(httpContext), cancellationToken);
        return result.Status switch
        {
            DeviceOperationStatus.Succeeded or DeviceOperationStatus.Replayed => TypedResults.Ok(result.Value),
            DeviceOperationStatus.Unauthorized => Problem(StatusCodes.Status403Forbidden, "Device disabled", result.Detail),
            DeviceOperationStatus.Invalid => Problem(StatusCodes.Status400BadRequest, "Invalid claim", result.Detail),
            DeviceOperationStatus.Conflict => Problem(StatusCodes.Status409Conflict, "Task claim conflict", result.Detail),
            _ => Problem(StatusCodes.Status500InternalServerError, "Task claim failed", result.Detail)
        };
    }

    private static async Task<IResult> AppendEventAsync(
        Guid taskId,
        HttpContext httpContext,
        DeviceCoordinationService service,
        DeviceTaskEventRequest? request,
        CancellationToken cancellationToken)
    {
        if (!TryGetDeviceId(httpContext, out var deviceId))
        {
            return Problem(StatusCodes.Status401Unauthorized, "Unauthorized", "A device credential is required.");
        }

        var result = await service.AppendEventAsync(deviceId, taskId, request, LeaseOwner(httpContext), IdempotencyKey(httpContext), cancellationToken);
        return result.Status switch
        {
            DeviceOperationStatus.Succeeded or DeviceOperationStatus.Replayed => TypedResults.Ok(result.Value),
            DeviceOperationStatus.Invalid => Problem(StatusCodes.Status400BadRequest, "Invalid task event", result.Detail),
            DeviceOperationStatus.NotFound => Problem(StatusCodes.Status404NotFound, "Task execution not found", result.Detail),
            DeviceOperationStatus.Conflict => Problem(StatusCodes.Status409Conflict, "Task event conflict", result.Detail),
            _ => Problem(StatusCodes.Status500InternalServerError, "Task event failed", result.Detail)
        };
    }

    private static async Task<IResult> ListActiveAsync(
        HttpContext httpContext,
        DeviceCoordinationService service,
        CancellationToken cancellationToken)
    {
        if (!TryGetDeviceId(httpContext, out var deviceId))
        {
            return Problem(StatusCodes.Status401Unauthorized, "Unauthorized", "A device credential is required.");
        }

        var result = await service.ListActiveAsync(deviceId, cancellationToken);
        return result.Status switch
        {
            DeviceOperationStatus.Succeeded => TypedResults.Ok(result.Value),
            DeviceOperationStatus.Unauthorized => Problem(StatusCodes.Status403Forbidden, "Device disabled", result.Detail),
            _ => Problem(StatusCodes.Status400BadRequest, "Invalid device recovery request", result.Detail)
        };
    }

    private static async Task<IResult> RenewLeaseAsync(
        Guid taskId,
        HttpContext httpContext,
        DeviceCoordinationService service,
        DeviceTaskLeaseRenewRequest? request,
        CancellationToken cancellationToken)
    {
        if (!TryGetDeviceId(httpContext, out var deviceId))
        {
            return Problem(StatusCodes.Status401Unauthorized, "Unauthorized", "A device credential is required.");
        }

        var result = await service.RenewLeaseAsync(deviceId, taskId, request, IdempotencyKey(httpContext), cancellationToken);
        return result.Status switch
        {
            DeviceOperationStatus.Succeeded or DeviceOperationStatus.Replayed => TypedResults.Ok(result.Value),
            DeviceOperationStatus.Invalid => Problem(StatusCodes.Status400BadRequest, "Invalid lease renewal", result.Detail),
            DeviceOperationStatus.NotFound => Problem(StatusCodes.Status404NotFound, "Task not found", result.Detail),
            DeviceOperationStatus.Conflict => Problem(StatusCodes.Status409Conflict, "Lease conflict", result.Detail),
            _ => Problem(StatusCodes.Status500InternalServerError, "Lease renewal failed", result.Detail)
        };
    }

    private static async Task<IResult> CreateApprovalAsync(
        Guid taskId,
        HttpContext httpContext,
        DeviceCoordinationService service,
        DeviceApprovalRequest? request,
        CancellationToken cancellationToken)
    {
        if (!TryGetDeviceId(httpContext, out var deviceId))
        {
            return Problem(StatusCodes.Status401Unauthorized, "Unauthorized", "A device credential is required.");
        }

        var result = await service.CreateApprovalAsync(deviceId, taskId, request, LeaseOwner(httpContext), IdempotencyKey(httpContext), cancellationToken);
        return result.Status switch
        {
            DeviceOperationStatus.Succeeded => Results.Created($"/api/v1/approvals/{result.Value!.ApprovalId}", result.Value),
            DeviceOperationStatus.Replayed => Results.Ok(result.Value),
            DeviceOperationStatus.Invalid => Problem(StatusCodes.Status400BadRequest, "Invalid approval", result.Detail),
            DeviceOperationStatus.Conflict => Problem(StatusCodes.Status409Conflict, "Approval conflict", result.Detail),
            DeviceOperationStatus.Unauthorized => Problem(StatusCodes.Status403Forbidden, "Device disabled", result.Detail),
            _ => Problem(StatusCodes.Status500InternalServerError, "Approval creation failed", result.Detail)
        };
    }

    private static async Task<IResult> GetTaskAsync(
        Guid taskId,
        HttpContext httpContext,
        DeviceCoordinationService service,
        CancellationToken cancellationToken)
    {
        if (!TryGetDeviceId(httpContext, out var deviceId))
        {
            return Problem(StatusCodes.Status401Unauthorized, "Unauthorized", "A device credential is required.");
        }

        var result = await service.GetTaskAsync(deviceId, taskId, cancellationToken);
        return result.Status switch
        {
            DeviceOperationStatus.Succeeded => TypedResults.Ok(result.Value),
            DeviceOperationStatus.NotFound => Problem(StatusCodes.Status404NotFound, "Task not found", result.Detail),
            _ => Problem(StatusCodes.Status400BadRequest, "Invalid task", result.Detail)
        };
    }

    private static async Task<IResult> GetApprovalAsync(
        Guid taskId,
        Guid approvalId,
        HttpContext httpContext,
        DeviceCoordinationService service,
        CancellationToken cancellationToken)
    {
        if (!TryGetDeviceId(httpContext, out var deviceId))
        {
            return Problem(StatusCodes.Status401Unauthorized, "Unauthorized", "A device credential is required.");
        }

        var result = await service.GetApprovalAsync(deviceId, taskId, approvalId, cancellationToken);
        return result.Status switch
        {
            DeviceOperationStatus.Succeeded => TypedResults.Ok(result.Value),
            DeviceOperationStatus.NotFound => Problem(StatusCodes.Status404NotFound, "Approval not found", result.Detail),
            _ => Problem(StatusCodes.Status400BadRequest, "Invalid approval", result.Detail)
        };
    }

    private static async Task<IResult> CreateUserInputAsync(
        Guid taskId,
        HttpContext httpContext,
        DeviceCoordinationService service,
        DeviceTaskUserInputRequest? request,
        CancellationToken cancellationToken)
    {
        if (!TryGetDeviceId(httpContext, out var deviceId))
        {
            return Problem(StatusCodes.Status401Unauthorized, "Unauthorized", "A device credential is required.");
        }

        var result = await service.CreateUserInputAsync(
            deviceId,
            taskId,
            request,
            LeaseOwner(httpContext),
            IdempotencyKey(httpContext),
            cancellationToken);
        return result.Status switch
        {
            TaskUserInputOperationStatus.Succeeded => Results.Created($"/api/v1/device-tasks/{taskId:D}/user-input/{result.Value!.RequestId}", result.Value),
            TaskUserInputOperationStatus.Replayed => Results.Ok(result.Value),
            TaskUserInputOperationStatus.Invalid => Problem(StatusCodes.Status400BadRequest, "Invalid user-input request", result.Detail),
            TaskUserInputOperationStatus.NotFound => Problem(StatusCodes.Status404NotFound, "Task execution not found", result.Detail),
            TaskUserInputOperationStatus.Unauthorized => Problem(StatusCodes.Status403Forbidden, "Device disabled", result.Detail),
            TaskUserInputOperationStatus.StateConflict or TaskUserInputOperationStatus.Conflict
                => Problem(StatusCodes.Status409Conflict, "User-input request conflict", result.Detail),
            _ => Problem(StatusCodes.Status500InternalServerError, "User-input request failed", result.Detail)
        };
    }

    private static async Task<IResult> GetUserInputAsync(
        Guid taskId,
        string requestId,
        HttpContext httpContext,
        DeviceCoordinationService service,
        Guid? executionId,
        bool? requestIdIsString,
        CancellationToken cancellationToken)
    {
        if (!TryGetDeviceId(httpContext, out var deviceId))
        {
            return Problem(StatusCodes.Status401Unauthorized, "Unauthorized", "A device credential is required.");
        }

        var result = await service.GetUserInputAsync(deviceId, taskId, executionId ?? Guid.Empty, requestId, requestIdIsString ?? true, LeaseOwner(httpContext), cancellationToken);
        return result.Status switch
        {
            TaskUserInputOperationStatus.Succeeded => TypedResults.Ok(result.Value),
            TaskUserInputOperationStatus.NotFound => Problem(StatusCodes.Status404NotFound, "User-input request not found", result.Detail),
            TaskUserInputOperationStatus.Invalid => Problem(StatusCodes.Status400BadRequest, "Invalid user-input request identity", result.Detail),
            TaskUserInputOperationStatus.StateConflict => Problem(StatusCodes.Status409Conflict, "User-input request conflict", result.Detail),
            _ => Problem(StatusCodes.Status500InternalServerError, "User-input request lookup failed", result.Detail)
        };
    }

    private static async Task<IResult> ResolveUserInputAsync(
        Guid taskId,
        string requestId,
        HttpContext httpContext,
        DeviceCoordinationService service,
        Guid? executionId,
        bool? requestIdIsString,
        CancellationToken cancellationToken)
    {
        if (!TryGetDeviceId(httpContext, out var deviceId))
        {
            return Problem(StatusCodes.Status401Unauthorized, "Unauthorized", "A device credential is required.");
        }

        var result = await service.ResolveUserInputAsync(
            deviceId,
            taskId,
            executionId ?? Guid.Empty,
            requestId,
            requestIdIsString ?? true,
            LeaseOwner(httpContext),
            IdempotencyKey(httpContext),
            cancellationToken);
        return result.Status switch
        {
            TaskUserInputOperationStatus.Succeeded or TaskUserInputOperationStatus.Replayed => TypedResults.Ok(result.Value),
            TaskUserInputOperationStatus.Invalid => Problem(StatusCodes.Status400BadRequest, "Invalid user-input resolution", result.Detail),
            TaskUserInputOperationStatus.NotFound => Problem(StatusCodes.Status404NotFound, "User-input request not found", result.Detail),
            TaskUserInputOperationStatus.StateConflict or TaskUserInputOperationStatus.Conflict
                => Problem(StatusCodes.Status409Conflict, "User-input resolution conflict", result.Detail),
            TaskUserInputOperationStatus.Unauthorized => Problem(StatusCodes.Status403Forbidden, "Device disabled", result.Detail),
            _ => Problem(StatusCodes.Status500InternalServerError, "User-input resolution failed", result.Detail)
        };
    }

    private static string? IdempotencyKey(HttpContext context) => context.Request.Headers["Idempotency-Key"].FirstOrDefault();

    private static string? LeaseOwner(HttpContext context) => context.Request.Headers["X-Lease-Owner"].FirstOrDefault();

    private static bool TryGetUserId(HttpContext context, out Guid userId) => Guid.TryParse(context.User.FindFirstValue(ClaimTypes.NameIdentifier), out userId);

    private static bool TryGetDeviceId(HttpContext context, out Guid deviceId) => Guid.TryParse(context.User.FindFirstValue(ClaimTypes.NameIdentifier), out deviceId);

    private static bool OwnsDevice(HttpContext context, Guid deviceId) => TryGetDeviceId(context, out var credentialDeviceId) && credentialDeviceId == deviceId;

    private static IResult Problem(int statusCode, string title, string? detail) => Results.Problem(statusCode: statusCode, title: title, detail: detail, type: $"https://httpstatuses.com/{statusCode}");
}
