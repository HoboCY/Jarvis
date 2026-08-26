using System.Net;
using System.Net.Http.Headers;
using Jarvis.Infrastructure.Resilience;
using Microsoft.Extensions.DependencyInjection;
using Polly.CircuitBreaker;
using Xunit;

namespace Jarvis.Infrastructure.Tests;

public sealed class Phase6ResilienceTests
{
    [Fact]
    public async Task GetRetriesTransientServerFailureAndEventuallySucceeds()
    {
        var handler = new ScriptedHandler(HttpStatusCode.InternalServerError, HttpStatusCode.OK);
        using var provider = CreateProvider(handler, new ResilienceOptions
        {
            MaxRetryAttempts = 1,
            RetryBaseDelayMs = 1,
            AttemptTimeoutMs = 500,
            TotalTimeoutMs = 1_000,
            CircuitMinimumThroughput = 10
        });
        using var client = provider.GetRequiredService<IHttpClientFactory>().CreateClient("phase6");

        using var response = await client.GetAsync("https://example.test/health");

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        Assert.Equal(2, handler.CallCount);
    }

    [Fact]
    public async Task PostWithoutExplicitIdempotentRetryIsNotReplayed()
    {
        var handler = new ScriptedHandler(HttpStatusCode.ServiceUnavailable, HttpStatusCode.OK);
        using var provider = CreateProvider(handler, new ResilienceOptions
        {
            MaxRetryAttempts = 2,
            RetryBaseDelayMs = 1,
            AttemptTimeoutMs = 500,
            TotalTimeoutMs = 1_000,
            CircuitMinimumThroughput = 10
        });
        using var client = provider.GetRequiredService<IHttpClientFactory>().CreateClient("phase6");

        using var response = await client.PostAsync("https://example.test/write", new StringContent("payload"));

        Assert.Equal(HttpStatusCode.ServiceUnavailable, response.StatusCode);
        Assert.Equal(1, handler.CallCount);
    }

    [Fact]
    public async Task IdempotentPostWithExplicitOptInRetries()
    {
        var handler = new ScriptedHandler(HttpStatusCode.TooManyRequests, HttpStatusCode.OK);
        using var provider = CreateProvider(handler, new ResilienceOptions
        {
            MaxRetryAttempts = 1,
            RetryBaseDelayMs = 1,
            AttemptTimeoutMs = 500,
            TotalTimeoutMs = 1_000,
            CircuitMinimumThroughput = 10
        });
        using var client = provider.GetRequiredService<IHttpClientFactory>().CreateClient("phase6");
        using var request = new HttpRequestMessage(HttpMethod.Post, "https://example.test/idempotent")
        {
            Content = new StringContent("payload")
        };
        request.Headers.Add("Idempotency-Key", "stable-key");
        request.Options.Set(JarvisHttpResilience.AllowIdempotentRetry, true);

        using var response = await client.SendAsync(request);

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        Assert.Equal(2, handler.CallCount);
    }

    [Fact]
    public async Task CircuitOpensAfterConfiguredFailuresAndRecoversAfterBreakDuration()
    {
        var handler = new ScriptedHandler(
            HttpStatusCode.BadGateway,
            HttpStatusCode.BadGateway,
            HttpStatusCode.OK);
        using var provider = CreateProvider(handler, new ResilienceOptions
        {
            MaxRetryAttempts = 0,
            AttemptTimeoutMs = 500,
            TotalTimeoutMs = 1_000,
            CircuitFailureRatio = 1,
            CircuitMinimumThroughput = 2,
            CircuitSamplingDurationMs = 10_000,
            CircuitBreakDurationMs = 600
        });
        using var client = provider.GetRequiredService<IHttpClientFactory>().CreateClient("phase6");

        using var first = await client.GetAsync("https://example.test/circuit");
        using var second = await client.GetAsync("https://example.test/circuit");
        await Assert.ThrowsAsync<BrokenCircuitException>(
            () => client.GetAsync("https://example.test/circuit"));
        await Task.Delay(700);
        using var recovered = await client.GetAsync("https://example.test/circuit");

        Assert.Equal(HttpStatusCode.BadGateway, first.StatusCode);
        Assert.Equal(HttpStatusCode.BadGateway, second.StatusCode);
        Assert.Equal(HttpStatusCode.OK, recovered.StatusCode);
        Assert.Equal(3, handler.CallCount);
    }

    private static ServiceProvider CreateProvider(HttpMessageHandler handler, ResilienceOptions options)
    {
        var services = new ServiceCollection();
        services.AddSingleton(options);
        services.AddHttpClient("phase6")
            .ConfigurePrimaryHttpMessageHandler(() => handler)
            .AddJarvisHttpResilience(options);
        return services.BuildServiceProvider();
    }

    private sealed class ScriptedHandler(params HttpStatusCode[] responses) : HttpMessageHandler
    {
        private readonly Queue<HttpStatusCode> responses = new(responses);
        public int CallCount { get; private set; }

        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
        {
            CallCount++;
            var status = responses.Count > 0 ? responses.Dequeue() : HttpStatusCode.OK;
            return Task.FromResult(new HttpResponseMessage(status)
            {
                RequestMessage = request
            });
        }
    }
}
