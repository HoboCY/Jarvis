using System.Net;
using System.Net.Http;
using Jarvis.Infrastructure.Observability;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Http.Resilience;
using Polly;
using Polly.CircuitBreaker;
using Polly.Retry;
using Polly.Timeout;

namespace Jarvis.Infrastructure.Resilience;

public sealed class ResilienceOptions
{
    public const string SectionName = "Resilience";

    public bool Enabled { get; set; } = true;

    public int MaxRetryAttempts { get; set; } = 2;

    public int RetryBaseDelayMs { get; set; } = 200;

    public int RetryMaxDelayMs { get; set; } = 5_000;

    public int AttemptTimeoutMs { get; set; } = 10_000;

    public int TotalTimeoutMs { get; set; } = 30_000;

    public double CircuitFailureRatio { get; set; } = 0.5;

    public int CircuitMinimumThroughput { get; set; } = 10;

    public int CircuitSamplingDurationMs { get; set; } = 30_000;

    public int CircuitBreakDurationMs { get; set; } = 30_000;

    public int MaxRetryAfterMs { get; set; } = 10_000;
}

public static class JarvisHttpResilience
{
    public static readonly HttpRequestOptionsKey<bool> AllowIdempotentRetry =
        new("Jarvis.AllowIdempotentRetry");

    public static IHttpClientBuilder AddJarvisHttpResilience(
        this IHttpClientBuilder builder,
        ResilienceOptions options)
    {
        ArgumentNullException.ThrowIfNull(builder);
        ArgumentNullException.ThrowIfNull(options);
        return AddJarvisHttpResilience(builder, _ => options);
    }

    public static IHttpClientBuilder AddJarvisHttpResilience(
        this IHttpClientBuilder builder,
        Func<IServiceProvider, ResilienceOptions> optionsFactory)
    {
        ArgumentNullException.ThrowIfNull(builder);
        ArgumentNullException.ThrowIfNull(optionsFactory);
        builder.AddResilienceHandler("jarvis-http", (pipeline, context) =>
        {
            var options = optionsFactory(context.ServiceProvider);
            var stateObserver = context.ServiceProvider.GetService<IRuntimeStateObserver>();
            if (!options.Enabled)
            {
                stateObserver?.SetCircuit("http", "disabled");
                return;
            }

            stateObserver?.SetCircuit("http", "closed");

            pipeline.AddTimeout(new TimeoutStrategyOptions
            {
                Timeout = TimeSpan.FromMilliseconds(Math.Clamp(options.TotalTimeoutMs, 1, 600_000))
            });
            if (options.MaxRetryAttempts > 0)
            {
                pipeline.AddRetry(new HttpRetryStrategyOptions
                {
                    MaxRetryAttempts = Math.Clamp(options.MaxRetryAttempts, 1, 5),
                    Delay = TimeSpan.FromMilliseconds(Math.Clamp(options.RetryBaseDelayMs, 1, 60_000)),
                    MaxDelay = TimeSpan.FromMilliseconds(Math.Clamp(options.RetryMaxDelayMs, 1, 600_000)),
                    BackoffType = DelayBackoffType.Exponential,
                    UseJitter = true,
                    ShouldRetryAfterHeader = true,
                    ShouldHandle = args => new ValueTask<bool>(ShouldRetry(args.Outcome, args.Context)),
                    DelayGenerator = args => new ValueTask<TimeSpan?>(RetryAfterOrNull(args.Outcome, options))
                });
            }
            pipeline.AddCircuitBreaker(new HttpCircuitBreakerStrategyOptions
            {
                FailureRatio = Math.Clamp(options.CircuitFailureRatio, 0.01, 1),
                MinimumThroughput = Math.Max(2, options.CircuitMinimumThroughput),
                SamplingDuration = TimeSpan.FromMilliseconds(Math.Max(501, options.CircuitSamplingDurationMs)),
                BreakDuration = TimeSpan.FromMilliseconds(Math.Max(501, options.CircuitBreakDurationMs)),
                ShouldHandle = args => new ValueTask<bool>(IsTransient(args.Outcome)),
                OnOpened = _ =>
                {
                    stateObserver?.SetCircuit("http", "open");
                    return default;
                },
                OnHalfOpened = _ =>
                {
                    stateObserver?.SetCircuit("http", "half-open");
                    return default;
                },
                OnClosed = _ =>
                {
                    stateObserver?.SetCircuit("http", "closed");
                    return default;
                }
            });
            pipeline.AddTimeout(new TimeoutStrategyOptions
            {
                Timeout = TimeSpan.FromMilliseconds(Math.Clamp(options.AttemptTimeoutMs, 1, 600_000))
            });
        });
        return builder;
    }

    private static bool ShouldRetry(
        Outcome<HttpResponseMessage> outcome,
        ResilienceContext context)
    {
        var request = context.GetRequestMessage();
        if (request is null || !IsRetryAllowedForMethod(request))
        {
            return false;
        }

        return IsTransient(outcome);
    }

    private static bool IsRetryAllowedForMethod(HttpRequestMessage request)
    {
        if (request.Method == HttpMethod.Get
            || request.Method == HttpMethod.Head
            || request.Method == HttpMethod.Options)
        {
            return true;
        }

        return request.Options.TryGetValue(AllowIdempotentRetry, out var optedIn)
            && optedIn
            && request.Headers.TryGetValues("Idempotency-Key", out var values)
            && values.Any(value => !string.IsNullOrWhiteSpace(value));
    }

    private static bool IsTransient(Outcome<HttpResponseMessage> outcome)
    {
        if (outcome.Exception is HttpRequestException or TimeoutRejectedException)
        {
            return true;
        }

        var statusCode = outcome.Result?.StatusCode;
        return statusCode is HttpStatusCode.RequestTimeout
            or HttpStatusCode.TooManyRequests
            or >= HttpStatusCode.InternalServerError;
    }

    private static TimeSpan? RetryAfterOrNull(
        Outcome<HttpResponseMessage> outcome,
        ResilienceOptions options)
    {
        var retryAfter = outcome.Result?.Headers.RetryAfter;
        if (retryAfter?.Delta is TimeSpan delta)
        {
            return TimeSpan.FromMilliseconds(Math.Clamp(delta.TotalMilliseconds, 0, options.MaxRetryAfterMs));
        }

        if (retryAfter?.Date is DateTimeOffset date)
        {
            return TimeSpan.FromMilliseconds(Math.Clamp(
                (date - DateTimeOffset.UtcNow).TotalMilliseconds,
                0,
                options.MaxRetryAfterMs));
        }

        return null;
    }
}
