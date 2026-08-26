using Microsoft.Extensions.Options;

namespace Jarvis.Api.Diagnostics;

public static class DiagnosticsEndpoints
{
    public static IEndpointRouteBuilder MapDiagnosticsEndpoints(this IEndpointRouteBuilder endpoints)
    {
        endpoints.MapGet("/api/v1/diagnostics", GetDiagnosticsAsync)
            .RequireAuthorization()
            .WithName("GetDiagnostics")
            .Produces<DiagnosticsResponse>()
            .ProducesProblem(StatusCodes.Status401Unauthorized)
            .ProducesProblem(StatusCodes.Status403Forbidden);

        endpoints.MapGet("/health/live", GetLiveness)
            .RequireAuthorization()
            .WithName("HealthLive")
            .Produces<HealthResponse>();

        endpoints.MapGet("/health/ready", GetReadinessAsync)
            .RequireAuthorization()
            .WithName("HealthReady")
            .Produces<HealthResponse>()
            .ProducesProblem(StatusCodes.Status503ServiceUnavailable);

        return endpoints;
    }

    private static async Task<IResult> GetDiagnosticsAsync(
        HttpContext context,
        IOptions<DiagnosticsOptions> options,
        IHostEnvironment environment,
        DiagnosticsService service,
        CancellationToken cancellationToken)
    {
        if (!options.Value.IsLoopback(context, environment))
        {
            return Results.Problem(
                statusCode: StatusCodes.Status403Forbidden,
                title: "Loopback access required",
                detail: "Diagnostics are available only from the local machine.");
        }

        if (!options.Value.Enabled)
        {
            return Results.NotFound();
        }

        return Results.Ok(await service.GetAsync(cancellationToken).ConfigureAwait(false));
    }

    private static IResult GetLiveness(
        HttpContext context,
        IOptions<DiagnosticsOptions> options,
        IHostEnvironment environment)
    {
        return options.Value.IsLoopback(context, environment)
            ? Results.Ok(new HealthResponse("live", true))
            : Results.Problem(
                statusCode: StatusCodes.Status403Forbidden,
                title: "Loopback access required",
                detail: "Health endpoints are available only from the local machine.");
    }

    private static async Task<IResult> GetReadinessAsync(
        HttpContext context,
        IOptions<DiagnosticsOptions> options,
        IHostEnvironment environment,
        Jarvis.Infrastructure.Data.JarvisDbContext db,
        CancellationToken cancellationToken)
    {
        if (!options.Value.IsLoopback(context, environment))
        {
            return Results.Problem(
                statusCode: StatusCodes.Status403Forbidden,
                title: "Loopback access required",
                detail: "Health endpoints are available only from the local machine.");
        }

        try
        {
            var available = await db.Database.CanConnectAsync(cancellationToken).ConfigureAwait(false);
            return available
                ? Results.Ok(new HealthResponse("ready", true))
                : Results.Json(new HealthResponse("ready", false), statusCode: StatusCodes.Status503ServiceUnavailable);
        }
        catch (Exception) when (!cancellationToken.IsCancellationRequested)
        {
            return Results.Json(new HealthResponse("ready", false), statusCode: StatusCodes.Status503ServiceUnavailable);
        }
    }
}

public sealed record HealthResponse(string Status, bool Healthy);
