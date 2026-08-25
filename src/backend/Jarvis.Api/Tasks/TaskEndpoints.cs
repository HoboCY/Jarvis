using System.Security.Claims;
using Jarvis.Application.Tasks;
using Jarvis.Contracts;

namespace Jarvis.Api.Tasks;

public static class TaskEndpoints
{
    public static IEndpointRouteBuilder MapTaskEndpoints(this IEndpointRouteBuilder endpoints)
    {
        var group = endpoints
            .MapGroup("/api/v1/tasks")
            .RequireAuthorization();

        group.MapPost("", CreateAsync)
            .WithName("CreateTask")
            .WithSummary("Persist a background task and return without waiting for its worker.")
            .Produces<TaskAcceptedResponse>(StatusCodes.Status202Accepted)
            .ProducesProblem(StatusCodes.Status400BadRequest)
            .ProducesProblem(StatusCodes.Status401Unauthorized)
            .ProducesProblem(StatusCodes.Status404NotFound)
            .ProducesProblem(StatusCodes.Status409Conflict);

        group.MapGet("/{taskId:guid}", GetAsync)
            .WithName("GetTask")
            .Produces<TaskResponse>()
            .ProducesProblem(StatusCodes.Status401Unauthorized)
            .ProducesProblem(StatusCodes.Status404NotFound);

        group.MapGet("", ListAsync)
            .WithName("ListTasks")
            .Produces<TaskListResponse>()
            .ProducesProblem(StatusCodes.Status400BadRequest)
            .ProducesProblem(StatusCodes.Status401Unauthorized);

        group.MapPost("/{taskId:guid}/cancel", CancelAsync)
            .WithName("CancelTask")
            .Produces<TaskCancelResponse>()
            .ProducesProblem(StatusCodes.Status400BadRequest)
            .ProducesProblem(StatusCodes.Status401Unauthorized)
            .ProducesProblem(StatusCodes.Status404NotFound)
            .ProducesProblem(StatusCodes.Status409Conflict);

        return endpoints;
    }

    private static async Task<IResult> CreateAsync(
        HttpContext httpContext,
        TaskService service,
        CreateTaskRequest request,
        CancellationToken cancellationToken)
    {
        if (!TryGetUserId(httpContext, out var userId))
        {
            return Problem(StatusCodes.Status401Unauthorized, "Unauthorized", "Authentication is required.");
        }

        var result = await service.CreateAsync(
            userId,
            httpContext.Request.Headers["Idempotency-Key"].FirstOrDefault(),
            request,
            cancellationToken);
        return result.Status switch
        {
            TaskOperationStatus.Succeeded or TaskOperationStatus.Replayed
                => Results.Accepted($"/api/v1/tasks/{result.Value!.TaskId}", result.Value),
            TaskOperationStatus.Invalid => Problem(StatusCodes.Status400BadRequest, "Invalid task request", result.Detail),
            TaskOperationStatus.NotFound => Problem(StatusCodes.Status404NotFound, "Conversation not found", "The conversation does not exist or is not owned by this user."),
            TaskOperationStatus.Conflict => Problem(StatusCodes.Status409Conflict, "Idempotency conflict", result.Detail),
            _ => Problem(StatusCodes.Status500InternalServerError, "Unexpected result", "The task could not be persisted.")
        };
    }

    private static async Task<IResult> GetAsync(
        Guid taskId,
        HttpContext httpContext,
        TaskService service,
        CancellationToken cancellationToken)
    {
        if (!TryGetUserId(httpContext, out var userId))
        {
            return Problem(StatusCodes.Status401Unauthorized, "Unauthorized", "Authentication is required.");
        }

        var result = await service.GetAsync(userId, taskId, cancellationToken);
        return result.Status == TaskOperationStatus.Succeeded
            ? TypedResults.Ok(result.Value)
            : Problem(StatusCodes.Status404NotFound, "Task not found", "The task does not exist or is not owned by this user.");
    }

    private static async Task<IResult> ListAsync(
        HttpContext httpContext,
        TaskService service,
        Guid? conversationId,
        string? status,
        string? cursor,
        int? limit,
        CancellationToken cancellationToken)
    {
        if (!TryGetUserId(httpContext, out var userId))
        {
            return Problem(StatusCodes.Status401Unauthorized, "Unauthorized", "Authentication is required.");
        }

        var result = await service.ListAsync(userId, conversationId, status, cursor, limit ?? 20, cancellationToken);
        return result.Status == TaskOperationStatus.Succeeded
            ? TypedResults.Ok(result.Value)
            : Problem(StatusCodes.Status400BadRequest, "Invalid task filter", result.Detail);
    }

    private static async Task<IResult> CancelAsync(
        Guid taskId,
        HttpContext httpContext,
        TaskService service,
        CancellationToken cancellationToken)
    {
        if (!TryGetUserId(httpContext, out var userId))
        {
            return Problem(StatusCodes.Status401Unauthorized, "Unauthorized", "Authentication is required.");
        }

        var result = await service.CancelAsync(
            userId,
            taskId,
            httpContext.Request.Headers["Idempotency-Key"].FirstOrDefault(),
            cancellationToken);
        return result.Status switch
        {
            TaskOperationStatus.Succeeded or TaskOperationStatus.Replayed => TypedResults.Ok(result.Value),
            TaskOperationStatus.Invalid => Problem(StatusCodes.Status400BadRequest, "Invalid cancellation request", result.Detail),
            TaskOperationStatus.NotFound => Problem(StatusCodes.Status404NotFound, "Task not found", "The task does not exist or is not owned by this user."),
            TaskOperationStatus.StateConflict => Problem(StatusCodes.Status409Conflict, "Task state conflict", result.Detail),
            TaskOperationStatus.Conflict => Problem(StatusCodes.Status409Conflict, "Idempotency conflict", result.Detail),
            _ => Problem(StatusCodes.Status500InternalServerError, "Unexpected result", "The task could not be cancelled.")
        };
    }

    private static bool TryGetUserId(HttpContext context, out Guid userId)
    {
        var value = context.User.FindFirstValue(ClaimTypes.NameIdentifier);
        return Guid.TryParse(value, out userId);
    }

    private static IResult Problem(int statusCode, string title, string? detail)
    {
        return Results.Problem(
            statusCode: statusCode,
            title: title,
            detail: detail,
            type: $"https://httpstatuses.com/{statusCode}");
    }
}
