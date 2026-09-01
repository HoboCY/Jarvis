using System.Security.Claims;
using Jarvis.Api.Authentication;
using Jarvis.Application.Realtime;
using Jarvis.Contracts;

namespace Jarvis.Api.Realtime;

public static class RealtimeEndpoints
{
    public static IEndpointRouteBuilder MapRealtimeEndpoints(this IEndpointRouteBuilder endpoints)
    {
        var realtime = endpoints.MapGroup("/api/v1/realtime");
        realtime.MapPost("/desktop-device", GetDesktopDeviceAsync)
            .RequireAuthorization(AuthenticationConstants.LocalOnlyPolicy)
            .WithName("GetDesktopRealtimeDevice")
            .WithSummary("Returns the authenticated local user's seeded Desktop device.")
            .Produces<DesktopDeviceBootstrapResponse>()
            .ProducesProblem(StatusCodes.Status401Unauthorized);

        realtime.MapPost("/client-secrets", CreateClientSecretAsync)
            .RequireAuthorization()
            .WithName("CreateRealtimeClientSecret")
            .WithSummary("Creates a short-lived Realtime client secret for an owned conversation and Desktop device.")
            .RequireRateLimiting("realtime-client-secret")
            .Produces<RealtimeClientSecretResponse>()
            .ProducesProblem(StatusCodes.Status400BadRequest)
            .ProducesProblem(StatusCodes.Status401Unauthorized)
            .ProducesProblem(StatusCodes.Status404NotFound)
            .ProducesProblem(StatusCodes.Status409Conflict)
            .ProducesProblem(StatusCodes.Status429TooManyRequests)
            .ProducesProblem(StatusCodes.Status502BadGateway);

        realtime.MapPost("/sessions/{sessionId:guid}/connected", MarkConnectedAsync)
            .RequireAuthorization()
            .WithName("MarkRealtimeSessionConnected")
            .WithSummary("Records that the Desktop connected its ephemeral Realtime session.")
            .Produces<RealtimeSessionResponse>()
            .ProducesProblem(StatusCodes.Status400BadRequest)
            .ProducesProblem(StatusCodes.Status401Unauthorized)
            .ProducesProblem(StatusCodes.Status404NotFound)
            .ProducesProblem(StatusCodes.Status409Conflict);

        realtime.MapPost("/sessions/{sessionId:guid}/ended", MarkEndedAsync)
            .RequireAuthorization()
            .WithName("MarkRealtimeSessionEnded")
            .WithSummary("Records a Realtime session disconnect, rotation, or failure.")
            .Produces<RealtimeSessionResponse>()
            .ProducesProblem(StatusCodes.Status400BadRequest)
            .ProducesProblem(StatusCodes.Status401Unauthorized)
            .ProducesProblem(StatusCodes.Status404NotFound)
            .ProducesProblem(StatusCodes.Status409Conflict);

        var conversations = endpoints.MapGroup("/api/v1/conversations");
        conversations.MapPost("/{conversationId:guid}/realtime-events:ingest", IngestEventsAsync)
            .RequireAuthorization()
            .WithName("IngestRealtimeEvents")
            .WithSummary("Persists versioned normalized Realtime events into an owned conversation.")
            .Produces<RealtimeEventsIngestResponse>()
            .ProducesProblem(StatusCodes.Status400BadRequest)
            .ProducesProblem(StatusCodes.Status401Unauthorized)
            .ProducesProblem(StatusCodes.Status404NotFound)
            .ProducesProblem(StatusCodes.Status409Conflict);

        return endpoints;
    }

    private static async Task<IResult> GetDesktopDeviceAsync(
        HttpContext httpContext,
        RealtimeService service,
        CancellationToken cancellationToken)
    {
        if (!TryGetUserId(httpContext, out var userId))
        {
            return Problem(StatusCodes.Status401Unauthorized, "Unauthorized", "Authentication is required.");
        }

        var result = await service.GetDesktopDeviceAsync(
            userId,
            httpContext.Request.Headers["Idempotency-Key"].FirstOrDefault(),
            cancellationToken);
        return result.Status switch
        {
            RealtimeOperationStatus.Succeeded => TypedResults.Ok(result.Value),
            RealtimeOperationStatus.Invalid => Problem(StatusCodes.Status400BadRequest, "Invalid request", result.Detail),
            _ => Problem(StatusCodes.Status404NotFound, "Device not found", "The authenticated local user is not initialized.")
        };
    }

    private static async Task<IResult> CreateClientSecretAsync(
        HttpContext httpContext,
        RealtimeService service,
        RealtimeClientSecretRequest request,
        CancellationToken cancellationToken)
    {
        if (!TryGetUserId(httpContext, out var userId))
        {
            return Problem(StatusCodes.Status401Unauthorized, "Unauthorized", "Authentication is required.");
        }

        try
        {
            var result = await service.CreateClientSecretAsync(
                userId,
                httpContext.Request.Headers["Idempotency-Key"].FirstOrDefault(),
                request,
                cancellationToken);
            return result.Status switch
            {
                RealtimeOperationStatus.Succeeded or RealtimeOperationStatus.Replayed => TypedResults.Ok(result.Value),
                RealtimeOperationStatus.Invalid => Problem(StatusCodes.Status400BadRequest, "Invalid request", result.Detail),
                RealtimeOperationStatus.NotFound => Problem(StatusCodes.Status404NotFound, "Realtime resource not found", "The conversation or Desktop device is not owned by this user."),
                RealtimeOperationStatus.Conflict => Problem(StatusCodes.Status409Conflict, "Idempotency conflict", result.Detail),
                _ => Problem(StatusCodes.Status502BadGateway, "Realtime provider unavailable", "The realtime client secret could not be created.")
            };
        }
        catch (ArgumentException exception)
        {
            return Problem(StatusCodes.Status400BadRequest, "Invalid realtime configuration", exception.Message);
        }
        catch (HttpRequestException)
        {
            return Problem(StatusCodes.Status502BadGateway, "Realtime provider unavailable", "The realtime client secret could not be created.");
        }
        catch (WakeWordConfigurationException exception)
        {
            return Problem(StatusCodes.Status502BadGateway, "Realtime provider unavailable", exception.Message);
        }
        catch (InvalidOperationException)
        {
            return Problem(StatusCodes.Status502BadGateway, "Realtime provider unavailable", "The realtime client secret could not be created.");
        }
    }

    private static async Task<IResult> MarkConnectedAsync(
        Guid sessionId,
        HttpContext httpContext,
        RealtimeService service,
        RealtimeSessionConnectedRequest request,
        CancellationToken cancellationToken)
    {
        if (!TryGetUserId(httpContext, out var userId))
        {
            return Problem(StatusCodes.Status401Unauthorized, "Unauthorized", "Authentication is required.");
        }

        return ToResult(await service.MarkConnectedAsync(
            userId,
            sessionId,
            httpContext.Request.Headers["Idempotency-Key"].FirstOrDefault(),
            request,
            cancellationToken));
    }

    private static async Task<IResult> MarkEndedAsync(
        Guid sessionId,
        HttpContext httpContext,
        RealtimeService service,
        RealtimeSessionEndedRequest request,
        CancellationToken cancellationToken)
    {
        if (!TryGetUserId(httpContext, out var userId))
        {
            return Problem(StatusCodes.Status401Unauthorized, "Unauthorized", "Authentication is required.");
        }

        return ToResult(await service.MarkEndedAsync(
            userId,
            sessionId,
            httpContext.Request.Headers["Idempotency-Key"].FirstOrDefault(),
            request,
            cancellationToken));
    }

    private static async Task<IResult> IngestEventsAsync(
        Guid conversationId,
        HttpContext httpContext,
        RealtimeService service,
        RealtimeEventsIngestRequest request,
        CancellationToken cancellationToken)
    {
        if (!TryGetUserId(httpContext, out var userId))
        {
            return Problem(StatusCodes.Status401Unauthorized, "Unauthorized", "Authentication is required.");
        }

        var result = await service.IngestEventsAsync(
            userId,
            conversationId,
            httpContext.Request.Headers["Idempotency-Key"].FirstOrDefault(),
            request,
            cancellationToken);
        return result.Status switch
        {
            RealtimeOperationStatus.Succeeded or RealtimeOperationStatus.Replayed => TypedResults.Ok(result.Value),
            RealtimeOperationStatus.Invalid => Problem(StatusCodes.Status400BadRequest, "Invalid realtime events", result.Detail),
            RealtimeOperationStatus.NotFound => Problem(StatusCodes.Status404NotFound, "Conversation not found", "The conversation does not exist or is not owned by this user."),
            RealtimeOperationStatus.Conflict => Problem(StatusCodes.Status409Conflict, "Realtime event conflict", result.Detail),
            _ => Problem(StatusCodes.Status500InternalServerError, "Unexpected result", "The realtime events could not be persisted.")
        };
    }

    private static IResult ToResult(RealtimeOperation<RealtimeSessionResponse> result)
    {
        return result.Status switch
        {
            RealtimeOperationStatus.Succeeded or RealtimeOperationStatus.Replayed => TypedResults.Ok(result.Value),
            RealtimeOperationStatus.Invalid => Problem(StatusCodes.Status400BadRequest, "Invalid request", result.Detail),
            RealtimeOperationStatus.NotFound => Problem(StatusCodes.Status404NotFound, "Realtime session not found", "The session does not exist or is not owned by this user."),
            RealtimeOperationStatus.Conflict => Problem(StatusCodes.Status409Conflict, "Realtime session conflict", result.Detail),
            _ => Problem(StatusCodes.Status500InternalServerError, "Unexpected result", "The realtime session could not be updated.")
        };
    }

    private static bool TryGetUserId(HttpContext context, out Guid userId)
    {
        return Guid.TryParse(context.User.FindFirstValue(ClaimTypes.NameIdentifier), out userId);
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
