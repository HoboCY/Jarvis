using System.Security.Claims;
using Jarvis.Api.Authentication;
using Jarvis.Application.Mobile;
using Jarvis.Contracts;

namespace Jarvis.Api.Mobile;

public static class MobilePairingEndpoints
{
    public static IEndpointRouteBuilder MapMobilePairingEndpoints(this IEndpointRouteBuilder endpoints)
    {
        endpoints.MapPost("/api/v1/mobile-pairings", CreatePairingAsync)
            .RequireAuthorization(AuthenticationConstants.LocalOnlyPolicy)
            .WithName("CreateMobilePairing")
            .WithSummary("Creates a short-lived one-time mobile pairing code for the local user.")
            .Produces<MobilePairingResponse>(StatusCodes.Status201Created)
            .ProducesProblem(StatusCodes.Status400BadRequest)
            .ProducesProblem(StatusCodes.Status401Unauthorized)
            .ProducesProblem(StatusCodes.Status409Conflict);

        endpoints.MapPost("/api/v1/mobile-pairings/exchange", ExchangeAsync)
            .AllowAnonymous()
            .RequireRateLimiting("mobile-pairing-exchange")
            .WithName("ExchangeMobilePairing")
            .WithSummary("Consumes a one-time mobile pairing code and creates a mobile session.")
            .Produces<MobileSessionResponse>()
            .ProducesProblem(StatusCodes.Status400BadRequest)
            .ProducesProblem(StatusCodes.Status401Unauthorized)
            .ProducesProblem(StatusCodes.Status429TooManyRequests);

        endpoints.MapPost("/api/v1/mobile-sessions/refresh", RefreshAsync)
            .AllowAnonymous()
            .RequireRateLimiting("mobile-session-refresh")
            .WithName("RefreshMobileSession")
            .WithSummary("Rotates a mobile refresh token and returns a new in-memory access token.")
            .Produces<MobileSessionResponse>()
            .ProducesProblem(StatusCodes.Status400BadRequest)
            .ProducesProblem(StatusCodes.Status401Unauthorized)
            .ProducesProblem(StatusCodes.Status429TooManyRequests);

        endpoints.MapPost("/api/v1/mobile-sessions/revoke", RevokeAsync)
            .RequireAuthorization(AuthenticationConstants.MobileOnlyPolicy)
            .WithName("RevokeMobileSession")
            .WithSummary("Revokes the current mobile session.")
            .Produces<MobileSessionRevokeResponse>()
            .ProducesProblem(StatusCodes.Status401Unauthorized)
            .ProducesProblem(StatusCodes.Status404NotFound)
            .ProducesProblem(StatusCodes.Status503ServiceUnavailable);

        return endpoints;
    }

    private static async Task<IResult> CreatePairingAsync(
        HttpContext httpContext,
        MobileSessionService service,
        MobilePairingRequest? request,
        CancellationToken cancellationToken)
    {
        if (!TryGetUserId(httpContext, out var userId))
        {
            return Problem(StatusCodes.Status401Unauthorized, "Unauthorized", "Authentication is required.");
        }

        var result = await service.CreatePairingAsync(
            userId,
            request,
            httpContext.Request.Headers["Idempotency-Key"].FirstOrDefault(),
            cancellationToken);
        return result.Status switch
        {
            MobileOperationStatus.Succeeded => Results.Created(
                $"/api/v1/mobile-pairings/{result.Value!.PairingId:D}",
                result.Value),
            MobileOperationStatus.Conflict => Problem(StatusCodes.Status409Conflict, "Pairing conflict", result.Detail),
            MobileOperationStatus.Invalid => Problem(StatusCodes.Status400BadRequest, "Invalid pairing request", result.Detail),
            _ => Problem(StatusCodes.Status500InternalServerError, "Pairing failed", "The pairing code could not be created.")
        };
    }

    private static async Task<IResult> ExchangeAsync(
        HttpContext httpContext,
        MobileSessionService service,
        MobilePairingExchangeRequest? request,
        CancellationToken cancellationToken)
    {
        var result = await service.ExchangeAsync(request, cancellationToken);
        return result.Status switch
        {
            MobileOperationStatus.Succeeded => TypedResults.Ok(result.Value),
            MobileOperationStatus.Invalid => Problem(StatusCodes.Status400BadRequest, "Invalid pairing request", result.Detail),
            MobileOperationStatus.Conflict => Problem(StatusCodes.Status409Conflict, "Pairing conflict", result.Detail),
            _ => Problem(StatusCodes.Status401Unauthorized, "Unauthorized", "The mobile pairing code is invalid or expired.")
        };
    }

    private static async Task<IResult> RefreshAsync(
        HttpContext httpContext,
        MobileSessionService service,
        MobileSessionRefreshRequest? request,
        CancellationToken cancellationToken)
    {
        var result = await service.RefreshAsync(request, cancellationToken);
        return result.Status switch
        {
            MobileOperationStatus.Succeeded => TypedResults.Ok(result.Value),
            MobileOperationStatus.Invalid => Problem(StatusCodes.Status400BadRequest, "Invalid session refresh", result.Detail),
            _ => Problem(StatusCodes.Status401Unauthorized, "Unauthorized", "The mobile session is invalid or expired.")
        };
    }

    private static async Task<IResult> RevokeAsync(
        HttpContext httpContext,
        MobileSessionService service,
        CancellationToken cancellationToken)
    {
        if (!TryGetUserId(httpContext, out var userId)
            || !Guid.TryParse(httpContext.User.FindFirstValue(AuthenticationConstants.MobileSessionClaim), out var sessionId))
        {
            return Problem(StatusCodes.Status401Unauthorized, "Unauthorized", "A mobile session is required.");
        }

        var result = await service.RevokeAsync(userId, sessionId, cancellationToken);
        return result.Status switch
        {
            MobileOperationStatus.Succeeded => TypedResults.Ok(result.Value),
            MobileOperationStatus.NotFound => Problem(StatusCodes.Status404NotFound, "Mobile session not found", "The mobile session does not exist."),
            MobileOperationStatus.Unavailable => Problem(StatusCodes.Status503ServiceUnavailable, "Mobile session unavailable", "The mobile session could not be revoked; retry after the database becomes available."),
            _ => Problem(StatusCodes.Status401Unauthorized, "Unauthorized", "The mobile session is invalid.")
        };
    }

    private static bool TryGetUserId(HttpContext context, out Guid userId) =>
        Guid.TryParse(context.User.FindFirstValue(ClaimTypes.NameIdentifier), out userId);

    private static IResult Problem(int statusCode, string title, string? detail) => Results.Problem(
        statusCode: statusCode,
        title: title,
        detail: detail,
        type: $"https://httpstatuses.com/{statusCode}");
}
