using System.Security.Claims;
using Jarvis.Application.Notifications;
using Jarvis.Contracts;

namespace Jarvis.Api.Notifications;

public static class NotificationEndpoints
{
    public static IEndpointRouteBuilder MapNotificationEndpoints(this IEndpointRouteBuilder endpoints)
    {
        var group = endpoints
            .MapGroup("/api/v1/notifications")
            .RequireAuthorization();

        group.MapGet("", ListUnreadAsync)
            .WithName("ListUnreadNotifications")
            .Produces<NotificationListResponse>()
            .ProducesProblem(StatusCodes.Status400BadRequest)
            .ProducesProblem(StatusCodes.Status401Unauthorized);

        group.MapPost("/{notificationId:guid}/delivered", (Guid notificationId, HttpContext context, NotificationService service, CancellationToken token)
                => UpdateAsync(notificationId, "delivered", context, service, token))
            .WithName("MarkNotificationDelivered")
            .Produces<NotificationResponse>()
            .ProducesProblem(StatusCodes.Status400BadRequest)
            .ProducesProblem(StatusCodes.Status401Unauthorized)
            .ProducesProblem(StatusCodes.Status404NotFound)
            .ProducesProblem(StatusCodes.Status409Conflict);

        group.MapPost("/{notificationId:guid}/read", (Guid notificationId, HttpContext context, NotificationService service, CancellationToken token)
                => UpdateAsync(notificationId, "read", context, service, token))
            .WithName("MarkNotificationRead")
            .Produces<NotificationResponse>()
            .ProducesProblem(StatusCodes.Status400BadRequest)
            .ProducesProblem(StatusCodes.Status401Unauthorized)
            .ProducesProblem(StatusCodes.Status404NotFound)
            .ProducesProblem(StatusCodes.Status409Conflict);

        group.MapPost("/{notificationId:guid}/dismiss", (Guid notificationId, HttpContext context, NotificationService service, CancellationToken token)
                => UpdateAsync(notificationId, "dismiss", context, service, token))
            .WithName("DismissNotification")
            .Produces<NotificationResponse>()
            .ProducesProblem(StatusCodes.Status400BadRequest)
            .ProducesProblem(StatusCodes.Status401Unauthorized)
            .ProducesProblem(StatusCodes.Status404NotFound)
            .ProducesProblem(StatusCodes.Status409Conflict);

        return endpoints;
    }

    private static async Task<IResult> ListUnreadAsync(
        HttpContext httpContext,
        NotificationService service,
        string? status,
        Guid? conversationId,
        CancellationToken cancellationToken)
    {
        if (!TryGetUserId(httpContext, out var userId))
        {
            return Problem(StatusCodes.Status401Unauthorized, "Unauthorized", "Authentication is required.");
        }

        if (!string.IsNullOrWhiteSpace(status) && !string.Equals(status, "unread", StringComparison.OrdinalIgnoreCase))
        {
            return Problem(StatusCodes.Status400BadRequest, "Invalid notification filter", "Only status=unread is supported.");
        }

        var result = await service.ListUnreadAsync(userId, conversationId, cancellationToken);
        return result.Status == NotificationOperationStatus.Succeeded
            ? TypedResults.Ok(result.Value)
            : Problem(StatusCodes.Status400BadRequest, "Invalid notification filter", result.Detail);
    }

    private static async Task<IResult> UpdateAsync(
        Guid notificationId,
        string action,
        HttpContext httpContext,
        NotificationService service,
        CancellationToken cancellationToken)
    {
        if (!TryGetUserId(httpContext, out var userId))
        {
            return Problem(StatusCodes.Status401Unauthorized, "Unauthorized", "Authentication is required.");
        }

        var result = await service.UpdateAsync(
            userId,
            notificationId,
            action,
            httpContext.Request.Headers["Idempotency-Key"].FirstOrDefault(),
            cancellationToken);
        return result.Status switch
        {
            NotificationOperationStatus.Succeeded or NotificationOperationStatus.Replayed => TypedResults.Ok(result.Value),
            NotificationOperationStatus.Invalid => Problem(StatusCodes.Status400BadRequest, "Invalid notification update", result.Detail),
            NotificationOperationStatus.NotFound => Problem(StatusCodes.Status404NotFound, "Notification not found", "The notification does not exist or is not owned by this user."),
            NotificationOperationStatus.Conflict => Problem(StatusCodes.Status409Conflict, "Notification state conflict", result.Detail),
            _ => Problem(StatusCodes.Status500InternalServerError, "Unexpected result", "The notification could not be updated.")
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
