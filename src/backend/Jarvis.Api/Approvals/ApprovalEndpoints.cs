using System.Security.Claims;
using Jarvis.Application.Approvals;
using Jarvis.Contracts;

namespace Jarvis.Api.Approvals;

public static class ApprovalEndpoints
{
    public static IEndpointRouteBuilder MapApprovalEndpoints(this IEndpointRouteBuilder endpoints)
    {
        var group = endpoints.MapGroup("/api/v1/approvals").RequireAuthorization();
        group.MapGet("", ListAsync)
            .WithName("ListPendingApprovals")
            .Produces<ApprovalListResponse>()
            .ProducesProblem(StatusCodes.Status401Unauthorized);
        group.MapPost("/{approvalId:guid}/decision", DecideAsync)
            .WithName("DecideApproval")
            .Produces<ApprovalResponse>()
            .ProducesProblem(StatusCodes.Status400BadRequest)
            .ProducesProblem(StatusCodes.Status401Unauthorized)
            .ProducesProblem(StatusCodes.Status404NotFound)
            .ProducesProblem(StatusCodes.Status409Conflict);
        return endpoints;
    }

    private static async Task<IResult> ListAsync(
        HttpContext httpContext,
        ApprovalService service,
        string? status,
        CancellationToken cancellationToken)
    {
        if (!TryGetUserId(httpContext, out var userId))
        {
            return Problem(StatusCodes.Status401Unauthorized, "Unauthorized", "Authentication is required.");
        }

        return TypedResults.Ok(await service.ListPendingAsync(userId, status, cancellationToken));
    }

    private static async Task<IResult> DecideAsync(
        Guid approvalId,
        HttpContext httpContext,
        ApprovalService service,
        ApprovalDecisionRequest? request,
        CancellationToken cancellationToken)
    {
        if (!TryGetUserId(httpContext, out var userId))
        {
            return Problem(StatusCodes.Status401Unauthorized, "Unauthorized", "Authentication is required.");
        }

        var result = await service.DecideAsync(userId, approvalId, request, httpContext.Request.Headers["Idempotency-Key"].FirstOrDefault(), cancellationToken);
        return result.Status switch
        {
            ApprovalOperationStatus.Succeeded or ApprovalOperationStatus.Replayed => TypedResults.Ok(result.Value),
            ApprovalOperationStatus.Invalid => Problem(StatusCodes.Status400BadRequest, "Invalid approval decision", result.Detail),
            ApprovalOperationStatus.NotFound => Problem(StatusCodes.Status404NotFound, "Approval not found", result.Detail),
            ApprovalOperationStatus.Conflict => Problem(StatusCodes.Status409Conflict, "Approval decision conflict", result.Detail),
            _ => Problem(StatusCodes.Status500InternalServerError, "Approval decision failed", result.Detail)
        };
    }

    private static bool TryGetUserId(HttpContext context, out Guid userId) => Guid.TryParse(context.User.FindFirstValue(ClaimTypes.NameIdentifier), out userId);

    private static IResult Problem(int statusCode, string title, string? detail) => Results.Problem(statusCode: statusCode, title: title, detail: detail, type: $"https://httpstatuses.com/{statusCode}");
}
