using System.Diagnostics;
using Jarvis.Infrastructure.Observability;

namespace Jarvis.Api.Observability;

public static class CorrelationIdMiddlewareConstants
{
    public const string HeaderName = "X-Correlation-ID";
    public const string ItemKey = "Jarvis.CorrelationId";
}

public sealed class CorrelationIdMiddleware(
    RequestDelegate next,
    ILogger<CorrelationIdMiddleware> logger)
{
    public async Task InvokeAsync(HttpContext context)
    {
        var correlationId = ReadCorrelationId(context.Request.Headers[CorrelationIdMiddlewareConstants.HeaderName].ToString())
            ?? Guid.CreateVersion7().ToString("N");
        context.Items[CorrelationIdMiddlewareConstants.ItemKey] = correlationId;

        using var scope = logger.BeginScope(new Dictionary<string, object?>
        {
            ["correlation.id"] = correlationId
        });
        Activity.Current?.SetTag("correlation.id", correlationId);
        context.Response.OnStarting(static state =>
        {
            var responseContext = (HttpContext)state;
            responseContext.Response.Headers[CorrelationIdMiddlewareConstants.HeaderName] =
                (string)responseContext.Items[CorrelationIdMiddlewareConstants.ItemKey]!;
            return Task.CompletedTask;
        }, context);

        await next(context);
    }

    private static string? ReadCorrelationId(string value)
    {
        if (value.Length is 0 or > 128)
        {
            return null;
        }

        foreach (var character in value)
        {
            if (!(char.IsLetterOrDigit(character)
                || character is '-' or '_' or '.' or ':'))
            {
                return null;
            }
        }

        return value;
    }
}

public static class CorrelationIdApplicationBuilderExtensions
{
    public static IApplicationBuilder UseJarvisCorrelationId(this IApplicationBuilder app)
    {
        ArgumentNullException.ThrowIfNull(app);
        return app.UseMiddleware<CorrelationIdMiddleware>();
    }
}
