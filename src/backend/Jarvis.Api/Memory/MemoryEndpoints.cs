using System.Security.Claims;
using Jarvis.Application.Memory;
using Jarvis.Contracts;
using Jarvis.Infrastructure.Memory;
using Microsoft.Extensions.Options;

namespace Jarvis.Api.Memory;

public static class MemoryEndpoints
{
    public static IEndpointRouteBuilder MapMemoryEndpoints(this IEndpointRouteBuilder endpoints)
    {
        var group = endpoints.MapGroup("/api/v1/memory-facts").RequireAuthorization();
        group.MapPost("", SaveAsync)
            .WithName("CreateMemoryFact")
            .WithSummary("Persist an explicit user memory fact after source-message validation.")
            .Produces<MemoryFactSaveResponse>()
            .ProducesProblem(StatusCodes.Status400BadRequest)
            .ProducesProblem(StatusCodes.Status401Unauthorized)
            .ProducesProblem(StatusCodes.Status404NotFound)
            .ProducesProblem(StatusCodes.Status409Conflict);
        group.MapPost("/{memoryId:guid}/retract", RetractAsync)
            .WithName("RetractMemoryFact")
            .WithSummary("Retract an owned memory fact.")
            .Produces<MemoryFactRetractResponse>()
            .ProducesProblem(StatusCodes.Status400BadRequest)
            .ProducesProblem(StatusCodes.Status401Unauthorized)
            .ProducesProblem(StatusCodes.Status404NotFound)
            .ProducesProblem(StatusCodes.Status409Conflict);
        return endpoints;
    }

    private static async Task<IResult> SaveAsync(
        HttpContext httpContext,
        MemoryService service,
        IOptions<MemoryOptions> options,
        CreateMemoryFactRequest request,
        CancellationToken cancellationToken)
    {
        if (!TryGetUserId(httpContext, out var userId))
        {
            return Problem(StatusCodes.Status401Unauthorized, "Unauthorized", "Authentication is required.");
        }

        return ToResult(await service.SaveAsync(
            userId,
            httpContext.Request.Headers["Idempotency-Key"].FirstOrDefault(),
            request,
            options.Value.SensitiveFactsAllowed,
            cancellationToken));
    }

    private static async Task<IResult> RetractAsync(
        Guid memoryId,
        HttpContext httpContext,
        MemoryService service,
        CancellationToken cancellationToken)
    {
        if (!TryGetUserId(httpContext, out var userId))
        {
            return Problem(StatusCodes.Status401Unauthorized, "Unauthorized", "Authentication is required.");
        }

        return ToResult(await service.RetractAsync(
            userId,
            memoryId,
            httpContext.Request.Headers["Idempotency-Key"].FirstOrDefault(),
            cancellationToken));
    }

    private static IResult ToResult(MemoryOperation<MemoryFactSaveResponse> result) => result.Status switch
    {
        MemoryOperationStatus.Succeeded or MemoryOperationStatus.Replayed => TypedResults.Ok(result.Value),
        MemoryOperationStatus.Invalid => Problem(StatusCodes.Status400BadRequest, "Invalid memory fact", result.Detail),
        MemoryOperationStatus.NotFound => Problem(StatusCodes.Status404NotFound, "Memory source not found", result.Detail),
        MemoryOperationStatus.Conflict => Problem(StatusCodes.Status409Conflict, "Memory fact conflict", result.Detail),
        _ => Problem(StatusCodes.Status500InternalServerError, "Unexpected result", "The memory fact could not be persisted.")
    };

    private static IResult ToResult(MemoryOperation<MemoryFactRetractResponse> result) => result.Status switch
    {
        MemoryOperationStatus.Succeeded or MemoryOperationStatus.Replayed => TypedResults.Ok(result.Value),
        MemoryOperationStatus.Invalid => Problem(StatusCodes.Status400BadRequest, "Invalid memory retract request", result.Detail),
        MemoryOperationStatus.NotFound => Problem(StatusCodes.Status404NotFound, "Memory fact not found", "The memory fact does not exist or is not owned by this user."),
        MemoryOperationStatus.Conflict => Problem(StatusCodes.Status409Conflict, "Memory retract conflict", result.Detail),
        _ => Problem(StatusCodes.Status500InternalServerError, "Unexpected result", "The memory fact could not be retracted.")
    };

    private static bool TryGetUserId(HttpContext context, out Guid userId) =>
        Guid.TryParse(context.User.FindFirstValue(ClaimTypes.NameIdentifier), out userId);

    private static IResult Problem(int statusCode, string title, string? detail) => Results.Problem(
        statusCode: statusCode,
        title: title,
        detail: detail,
        type: $"https://httpstatuses.com/{statusCode}");
}
