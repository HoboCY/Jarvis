using System.Net;
using System.Text;
using System.Text.Json;
using System.ClientModel;
using System.ClientModel.Primitives;
using Jarvis.Application.Responses;
using Jarvis.Infrastructure.Responses;
using Microsoft.Extensions.Options;
#pragma warning disable OPENAI001
using OpenAI.Responses;
using Xunit;

namespace Jarvis.Infrastructure.Tests;

public sealed class OpenAiResponsesRuntimeTests
{
    [Fact]
    public async Task CreateUsesResponsesContractAndMapsCompletedOutput()
    {
        var handler = new RecordingHandler(_ => JsonResponse(
            HttpStatusCode.OK,
            "{\"id\":\"resp_create_1\",\"object\":\"response\",\"status\":\"completed\",\"model\":\"gpt-test\",\"output\":[{\"type\":\"message\",\"id\":\"msg_1\",\"status\":\"completed\",\"role\":\"assistant\",\"content\":[{\"type\":\"output_text\",\"text\":\"hello\",\"annotations\":[]}]}]}"));
        var runtime = CreateRuntime(handler);

        var result = await runtime.CreateAsync(
            new ResponsesCreateRequest("gpt-test", "fixed instructions", "user input", "stable-key"),
            CancellationToken.None);

        Assert.Equal("resp_create_1", result.ResponseId);
        Assert.Equal(ResponsesStatus.Completed, result.Status);
        Assert.Equal("hello", result.OutputText);
        var request = Assert.Single(handler.Requests);
        Assert.Equal(HttpMethod.Post, request.Method);
        Assert.Equal("/responses", request.RequestUri!.AbsolutePath);
        Assert.Equal("stable-key", request.Headers.GetValues("Idempotency-Key").Single());
        using var body = JsonDocument.Parse(handler.Bodies.Single());
        Assert.Equal("gpt-test", body.RootElement.GetProperty("model").GetString());
        Assert.True(body.RootElement.GetProperty("background").GetBoolean());
        Assert.True(body.RootElement.GetProperty("store").GetBoolean());
        Assert.Equal("fixed instructions", body.RootElement.GetProperty("instructions").GetString());
        Assert.Equal("user input", body.RootElement.GetProperty("input")[0].GetProperty("content")[0].GetProperty("text").GetString());
    }

    [Theory]
    [InlineData("queued", ResponsesStatus.Queued)]
    [InlineData("in_progress", ResponsesStatus.InProgress)]
    [InlineData("completed", ResponsesStatus.Completed)]
    [InlineData("failed", ResponsesStatus.Failed)]
    [InlineData("cancelled", ResponsesStatus.Cancelled)]
    [InlineData("incomplete", ResponsesStatus.Incomplete)]
    public async Task RetrieveMapsProviderStatus(string providerStatus, ResponsesStatus expected)
    {
        var handler = new RecordingHandler(_ => JsonResponse(
            HttpStatusCode.OK,
            $"{{\"id\":\"resp_status\",\"object\":\"response\",\"status\":\"{providerStatus}\",\"model\":\"gpt-test\",\"output\":[]}}"));
        var runtime = CreateRuntime(handler);

        var result = await runtime.RetrieveAsync("resp_status", CancellationToken.None);

        Assert.Equal(expected, result.Status);
        Assert.Equal("/responses/resp_status", Assert.Single(handler.Requests).RequestUri!.AbsolutePath);
        Assert.Equal(HttpMethod.Get, handler.Requests.Single().Method);
    }

    [Fact]
    public async Task CancelUsesTheProviderCancelPath()
    {
        var handler = new RecordingHandler(_ => JsonResponse(
            HttpStatusCode.OK,
            "{\"id\":\"resp_cancel\",\"object\":\"response\",\"status\":\"cancelled\",\"model\":\"gpt-test\",\"output\":[]}"));
        var runtime = CreateRuntime(handler);

        var result = await runtime.CancelAsync("resp_cancel", CancellationToken.None);

        Assert.Equal(ResponsesStatus.Cancelled, result.Status);
        Assert.Equal(HttpMethod.Post, Assert.Single(handler.Requests).Method);
        Assert.Equal("/responses/resp_cancel/cancel", handler.Requests.Single().RequestUri!.AbsolutePath);
    }

    [Fact]
    public async Task TransientFailuresRetryWithTheSameCreateIdempotencyKeyAndStopAtTheConfiguredLimit()
    {
        var handler = new RecordingHandler(call => call <= 2
            ? JsonResponse(HttpStatusCode.TooManyRequests, "{\"error\":{\"message\":\"retry\"}}")
            : JsonResponse(HttpStatusCode.OK, "{\"id\":\"resp_retry\",\"object\":\"response\",\"status\":\"queued\",\"model\":\"gpt-test\",\"output\":[]}"));
        var runtime = CreateRuntime(handler, maxRetries: 2);

        var result = await runtime.CreateAsync(
            new ResponsesCreateRequest("gpt-test", "instructions", "input", "retry-key"),
            CancellationToken.None);

        Assert.Equal(ResponsesStatus.Queued, result.Status);
        Assert.True(handler.Requests.Count == 3);
        Assert.All(handler.Requests, request => Assert.Equal("retry-key", request.Headers.GetValues("Idempotency-Key").Single()));
    }

    [Fact]
    public async Task NetworkFailuresWithoutStatusAreRetriedAndCallerCancellationStopsTheOperation()
    {
        var attempts = 0;
        var handler = new RecordingHandler(_ =>
        {
            attempts++;
            throw new HttpRequestException("connection reset");
        });
        var runtime = CreateRuntime(handler, maxRetries: 2);

        var networkFailure = await Assert.ThrowsAsync<ClientResultException>(
            () => runtime.RetrieveAsync("resp_network", CancellationToken.None));
        Assert.IsType<HttpRequestException>(networkFailure.InnerException);
        Assert.Equal(3, attempts);

        using var cancellation = new CancellationTokenSource();
        var cancellingHandler = new RecordingHandler(_ =>
        {
            cancellation.Cancel();
            throw new HttpRequestException("connection reset");
        });
        var cancellingRuntime = CreateRuntime(cancellingHandler, maxRetries: 2);
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => cancellingRuntime.RetrieveAsync("resp_cancelled", cancellation.Token));
        Assert.True(cancellingHandler.Requests.Count == 1);
    }

    [Fact]
    public async Task TimeoutCancelsTheSdkTransportWithoutAnUnboundedPoll()
    {
        var handler = new TimeoutHandler();
        var runtime = CreateRuntime(handler, maxRetries: 0, timeoutSeconds: 1);

        await Assert.ThrowsAnyAsync<OperationCanceledException>(
            () => runtime.RetrieveAsync("resp_timeout", CancellationToken.None));

        Assert.True(handler.RequestCount == 1);
    }

    private static OpenAiResponsesRuntime CreateRuntime(
        HttpMessageHandler handler,
        int maxRetries = 0,
        int timeoutSeconds = 1)
    {
        var pipeline = ClientPipeline.Create(new ClientPipelineOptions
        {
            RetryPolicy = new ClientRetryPolicy(0),
            Transport = new HttpClientPipelineTransport(new HttpClient(handler))
        });
        var responsesOptions = Options.Create(new ResponsesOptions
        {
            Model = "gpt-test",
            TimeoutSeconds = timeoutSeconds,
            MaxTransientRetries = maxRetries
        });
        return new OpenAiResponsesRuntime(responsesOptions, new PipelineResponsesClientFactory(pipeline));
    }

    private static HttpResponseMessage JsonResponse(HttpStatusCode status, string json) => new(status)
    {
        Content = new StringContent(json, Encoding.UTF8, "application/json")
    };

    private sealed class PipelineResponsesClientFactory(ClientPipeline pipeline) : IResponsesClientFactory
    {
        public ResponsesClient Create(string model) => new TestResponsesClient(
            pipeline,
            new ResponsesClientOptions { Endpoint = new Uri("https://test.local/") });
    }

    private sealed class TestResponsesClient(
        ClientPipeline pipeline,
        ResponsesClientOptions options) : ResponsesClient(pipeline, options);

    private sealed class RecordingHandler(
        Func<int, HttpResponseMessage> responseFactory) : HttpMessageHandler
    {
        public List<HttpRequestMessage> Requests { get; } = [];

        public List<string> Bodies { get; } = [];

        private int callCount;

        protected override async Task<HttpResponseMessage> SendAsync(
            HttpRequestMessage request,
            CancellationToken cancellationToken)
        {
            Requests.Add(request);
            Bodies.Add(request.Content is null ? string.Empty : await request.Content.ReadAsStringAsync(cancellationToken));
            return responseFactory(++callCount);
        }
    }

    private sealed class TimeoutHandler : HttpMessageHandler
    {
        public int RequestCount { get; private set; }

        protected override async Task<HttpResponseMessage> SendAsync(
            HttpRequestMessage request,
            CancellationToken cancellationToken)
        {
            RequestCount++;
            await Task.Delay(Timeout.InfiniteTimeSpan, cancellationToken);
            throw new InvalidOperationException("The timeout transport should not return a response.");
        }
    }
}
