using System.ClientModel;
using System.ClientModel.Primitives;
using System.Net;
using System.Text;
using System.Text.Json;
using Jarvis.Application.Responses;
using Jarvis.Infrastructure.Responses;
using Microsoft.Extensions.Options;
using OpenAI.Responses;
using Xunit;

namespace Jarvis.Infrastructure.Tests;

#pragma warning disable OPENAI001
public sealed class DeepSeekResponsesRuntimeTests
{
    [Fact]
    public async Task CreateUsesSynchronousDeepSeekContractAndMapsCompletedOutput()
    {
        var handler = new RecordingHandler(_ => JsonResponse(
            HttpStatusCode.OK,
            "{\"id\":\"resp_deepseek_1\",\"object\":\"response\",\"status\":\"completed\",\"model\":\"deepseek-v4-flash\",\"output\":[{\"type\":\"message\",\"id\":\"msg_1\",\"status\":\"completed\",\"role\":\"assistant\",\"content\":[{\"type\":\"output_text\",\"text\":\"hello\",\"annotations\":[]}]}]}"));
        var runtime = CreateRuntime(handler);

        var result = await runtime.CreateAsync(
            new ResponsesCreateRequest("deepseek-v4-flash", "fixed instructions", "user input", "deepseek-key"),
            CancellationToken.None);

        Assert.Equal("resp_deepseek_1", result.ResponseId);
        Assert.Equal(ResponsesStatus.Completed, result.Status);
        Assert.Equal("hello", result.OutputText);
        var request = Assert.Single(handler.Requests);
        Assert.Equal(HttpMethod.Post, request.Method);
        Assert.Equal("https", request.RequestUri!.Scheme);
        Assert.Equal("api.deepseek.test", request.RequestUri.Host);
        Assert.Equal("/responses", request.RequestUri.AbsolutePath);
        Assert.Equal("Bearer deepseek-api-key", request.Headers.Authorization?.ToString());
        Assert.Equal("deepseek-key", request.Headers.GetValues("Idempotency-Key").Single());
        using var body = JsonDocument.Parse(handler.Bodies.Single());
        Assert.Equal("deepseek-v4-flash", body.RootElement.GetProperty("model").GetString());
        Assert.False(body.RootElement.GetProperty("background").GetBoolean());
        Assert.False(body.RootElement.GetProperty("store").GetBoolean());
        Assert.Equal("fixed instructions", body.RootElement.GetProperty("instructions").GetString());
        Assert.Equal("user input", body.RootElement.GetProperty("input")[0].GetProperty("content")[0].GetProperty("text").GetString());
    }

    [Theory]
    [InlineData("failed", ResponsesStatus.Failed)]
    [InlineData("incomplete", ResponsesStatus.Incomplete)]
    public async Task CreateMapsSynchronousTerminalFailures(string providerStatus, ResponsesStatus expectedStatus)
    {
        var handler = new RecordingHandler(_ => JsonResponse(
            HttpStatusCode.OK,
            $"{{\"id\":\"resp_terminal\",\"object\":\"response\",\"status\":\"{providerStatus}\",\"model\":\"deepseek-v4-flash\",\"output\":[]}}"));
        var runtime = CreateRuntime(handler);

        var result = await runtime.CreateAsync(
            new ResponsesCreateRequest("deepseek-v4-flash", "instructions", "input", "terminal-key"),
            CancellationToken.None);

        Assert.Equal(expectedStatus, result.Status);
    }

    [Theory]
    [InlineData("queued")]
    [InlineData("in_progress")]
    public async Task CreateFailsClosedWhenTheSynchronousProviderReturnsANonTerminalStatus(string providerStatus)
    {
        var handler = new RecordingHandler(_ => JsonResponse(
            HttpStatusCode.OK,
            $"{{\"id\":\"resp_non_terminal\",\"object\":\"response\",\"status\":\"{providerStatus}\",\"model\":\"deepseek-v4-flash\",\"output\":[]}}"));
        var runtime = CreateRuntime(handler);

        var result = await runtime.CreateAsync(
            new ResponsesCreateRequest("deepseek-v4-flash", "instructions", "input", "non-terminal-key"),
            CancellationToken.None);

        Assert.Equal("resp_non_terminal", result.ResponseId);
        Assert.Equal(ResponsesStatus.Failed, result.Status);
        Assert.Equal("responses_sync_non_terminal", result.ErrorCode);
        Assert.Contains("non-terminal", result.ErrorMessage, StringComparison.OrdinalIgnoreCase);
        Assert.Single(handler.Requests);
    }

    [Fact]
    public async Task TransientFailuresRetryWithTheSameTrackingKeyAndStopAtTheConfiguredLimit()
    {
        var handler = new RecordingHandler(call => call <= 2
            ? JsonResponse(HttpStatusCode.TooManyRequests, "{\"error\":{\"message\":\"retry\"}}")
            : JsonResponse(HttpStatusCode.OK, "{\"id\":\"resp_retry\",\"object\":\"response\",\"status\":\"completed\",\"model\":\"deepseek-v4-flash\",\"output\":[]}"));
        var runtime = CreateRuntime(handler, maxRetries: 2);

        var result = await runtime.CreateAsync(
            new ResponsesCreateRequest("deepseek-v4-flash", "instructions", "input", "retry-key"),
            CancellationToken.None);

        Assert.Equal(ResponsesStatus.Completed, result.Status);
        Assert.Equal(3, handler.Requests.Count);
        Assert.All(handler.Requests, request => Assert.Equal("retry-key", request.Headers.GetValues("Idempotency-Key").Single()));
    }

    [Fact]
    public async Task ServerFailuresAreNotRetriedBecauseCreateIsNotRecoverable()
    {
        var handler = new RecordingHandler(call => call == 1
            ? JsonResponse(HttpStatusCode.InternalServerError, "{\"error\":{\"message\":\"failed\"}}")
            : JsonResponse(HttpStatusCode.OK, "{\"id\":\"resp_retry\",\"object\":\"response\",\"status\":\"completed\",\"model\":\"deepseek-v4-flash\",\"output\":[]}"));
        var runtime = CreateRuntime(handler, maxRetries: 2);

        await Assert.ThrowsAsync<ClientResultException>(() => runtime.CreateAsync(
            new ResponsesCreateRequest("deepseek-v4-flash", "instructions", "input", "server-failure-key"),
            CancellationToken.None));

        Assert.Single(handler.Requests);
    }

    [Fact]
    public async Task NetworkFailuresAreNotRetriedBecauseCreateOutcomeIsUnknown()
    {
        var handler = new RecordingHandler(_ => throw new HttpRequestException("connection reset"));
        var runtime = CreateRuntime(handler, maxRetries: 2);

        await Assert.ThrowsAsync<ClientResultException>(() => runtime.CreateAsync(
            new ResponsesCreateRequest("deepseek-v4-flash", "instructions", "input", "network-failure-key"),
            CancellationToken.None));

        Assert.Single(handler.Requests);
    }

    [Fact]
    public async Task TimeoutsAreNotRetriedBecauseCreateOutcomeIsUnknown()
    {
        var handler = new TimeoutHandler();
        var runtime = CreateRuntime(handler, maxRetries: 2, timeoutSeconds: 1);

        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => runtime.CreateAsync(
            new ResponsesCreateRequest("deepseek-v4-flash", "instructions", "input", "timeout-key"),
            CancellationToken.None));

        Assert.Equal(1, handler.RequestCount);
    }

    [Fact]
    public async Task CallerCancellationStopsTheSynchronousRequest()
    {
        var entered = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var handler = new RecordingHandler(async (_, cancellationToken) =>
        {
            entered.SetResult();
            await Task.Delay(Timeout.InfiniteTimeSpan, cancellationToken);
            return JsonResponse(HttpStatusCode.OK, "{}");
        });
        var runtime = CreateRuntime(handler, maxRetries: 2);
        using var cancellation = new CancellationTokenSource();

        var operation = runtime.CreateAsync(
            new ResponsesCreateRequest("deepseek-v4-flash", "instructions", "input", "cancel-key"),
            cancellation.Token);
        await entered.Task;
        cancellation.Cancel();

        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => operation);
        Assert.Single(handler.Requests);
    }

    private static DeepSeekResponsesRuntime CreateRuntime(
        HttpMessageHandler handler,
        int maxRetries = 0,
        int timeoutSeconds = 2)
    {
        var pipeline = ClientPipeline.Create(new ClientPipelineOptions
        {
            RetryPolicy = new ClientRetryPolicy(0),
            Transport = new HttpClientPipelineTransport(new HttpClient(handler))
        },
        perCallPolicies: ReadOnlySpan<PipelinePolicy>.Empty,
        perTryPolicies: new[]
        {
            ApiKeyAuthenticationPolicy.CreateBearerAuthorizationPolicy(new ApiKeyCredential("deepseek-api-key"))
        },
        beforeTransportPolicies: ReadOnlySpan<PipelinePolicy>.Empty);
        var responsesOptions = Options.Create(new ResponsesOptions
        {
            Model = "deepseek-v4-flash",
            SummarizerModel = "deepseek-v4-flash",
            TimeoutSeconds = timeoutSeconds,
            MaxTransientRetries = maxRetries,
            PollingIntervalMs = 25
        });
        var factory = new PipelineResponsesClientFactory(pipeline);
        return new DeepSeekResponsesRuntime(responsesOptions, factory);
    }

    private static HttpResponseMessage JsonResponse(HttpStatusCode status, string json) => new(status)
    {
        Content = new StringContent(json, Encoding.UTF8, "application/json")
    };

    private sealed class PipelineResponsesClientFactory(ClientPipeline pipeline) : IResponsesClientFactory
    {
        public ResponsesClient Create(string model) => new TestResponsesClient(
            pipeline,
            new ResponsesClientOptions { Endpoint = new Uri("https://api.deepseek.test/") });
    }

    private sealed class TestResponsesClient(
        ClientPipeline pipeline,
        ResponsesClientOptions options) : ResponsesClient(pipeline, options);

    private sealed class RecordingHandler : HttpMessageHandler
    {
        private readonly Func<int, HttpResponseMessage>? responseFactory;
        private readonly Func<HttpRequestMessage, CancellationToken, Task<HttpResponseMessage>>? asyncResponseFactory;
        private int callCount;

        public RecordingHandler(Func<int, HttpResponseMessage> responseFactory)
        {
            this.responseFactory = responseFactory;
        }

        public RecordingHandler(Func<HttpRequestMessage, CancellationToken, Task<HttpResponseMessage>> responseFactory)
        {
            asyncResponseFactory = responseFactory;
        }

        public List<HttpRequestMessage> Requests { get; } = [];

        public List<string> Bodies { get; } = [];

        protected override async Task<HttpResponseMessage> SendAsync(
            HttpRequestMessage request,
            CancellationToken cancellationToken)
        {
            Requests.Add(request);
            Bodies.Add(request.Content is null ? string.Empty : await request.Content.ReadAsStringAsync(cancellationToken));
            if (asyncResponseFactory is not null)
            {
                return await asyncResponseFactory(request, cancellationToken);
            }

            return responseFactory!(++callCount);
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
