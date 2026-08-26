using System.Diagnostics;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using OpenTelemetry.Metrics;
using OpenTelemetry.Resources;
using OpenTelemetry.Trace;

namespace Jarvis.Infrastructure.Observability;

public static class JarvisTelemetryServiceCollectionExtensions
{
    public static IServiceCollection AddJarvisTelemetry(
        this IServiceCollection services,
        IConfiguration configuration,
        string serviceName,
        bool includeAspNetCoreInstrumentation = false)
    {
        services.AddOptions<ObservabilityOptions>()
            .Bind(configuration.GetSection(ObservabilityOptions.SectionName))
            .Validate(options => !string.IsNullOrWhiteSpace(options.ServiceName), "Observability:ServiceName is required.")
            .Validate(options => options.MaxLogValueLength is >= 128 and <= 100_000, "Observability:MaxLogValueLength must be between 128 and 100000.")
            .Validate(options => string.IsNullOrWhiteSpace(options.OtlpEndpoint)
                || Uri.TryCreate(options.OtlpEndpoint, UriKind.Absolute, out var endpoint)
                    && endpoint.Scheme is "http" or "https", "Observability:OtlpEndpoint must be an absolute HTTP(S) URI.")
            .ValidateOnStart();

        var options = configuration.GetSection(ObservabilityOptions.SectionName).Get<ObservabilityOptions>()
            ?? new ObservabilityOptions();
        var effectiveServiceName = string.IsNullOrWhiteSpace(options.ServiceName)
            ? serviceName
            : options.ServiceName;

        var builder = services.AddOpenTelemetry()
            .ConfigureResource(resource => resource.AddService(effectiveServiceName))
            .WithTracing(tracing =>
            {
                tracing.AddSource(JarvisTelemetry.ActivitySourceName);
                tracing.AddHttpClientInstrumentation();
                if (includeAspNetCoreInstrumentation)
                {
                    tracing.AddAspNetCoreInstrumentation();
                }
            })
            .WithMetrics(metrics =>
            {
                metrics.AddMeter(JarvisTelemetry.MeterName);
                metrics.AddRuntimeInstrumentation();
            });

        if (options.Enabled && Uri.TryCreate(options.OtlpEndpoint, UriKind.Absolute, out var endpoint))
        {
            builder.WithTracing(tracing => tracing.AddOtlpExporter(exporter => exporter.Endpoint = endpoint));
            builder.WithMetrics(metrics => metrics.AddOtlpExporter(exporter => exporter.Endpoint = endpoint));
        }

        return services;
    }
}
