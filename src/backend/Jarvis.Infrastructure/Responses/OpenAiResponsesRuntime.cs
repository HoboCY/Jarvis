using System.ClientModel;
using System.ClientModel.Primitives;
using Jarvis.Application.Responses;
using Jarvis.Infrastructure.Realtime;
using Jarvis.Infrastructure.Budgets;
using Microsoft.Extensions.Options;
using OpenAI.Responses;

namespace Jarvis.Infrastructure.Responses;

/// <summary>
/// Infrastructure-only adapter around the official OpenAI Responses SDK. The
/// application sees only the small create and stored-lifecycle ports.
/// </summary>
public sealed class OpenAiResponsesRuntime : IStoredResponsesRuntime
{
    private readonly IOptions<ResponsesOptions> responsesOptions;
    private readonly IResponsesClientFactory clientFactory;

    public OpenAiResponsesRuntime(
        IOptions<ResponsesOptions> responsesOptions,
        IResponsesClientFactory clientFactory)
    {
        this.responsesOptions = responsesOptions;
        this.clientFactory = clientFactory;
    }

    public async Task<ResponsesResult> CreateAsync(
        ResponsesCreateRequest request,
        CancellationToken cancellationToken)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(request.Model);
        ArgumentException.ThrowIfNullOrWhiteSpace(request.Input);
        ArgumentException.ThrowIfNullOrWhiteSpace(request.IdempotencyKey);

        return await ResponsesRuntimeRetry.ExecuteAsync(
            async token =>
            {
                var client = clientFactory.Create(request.Model);
                var createOptions = new CreateResponseOptions
                {
                    Model = request.Model,
                    Instructions = request.Instructions,
                    BackgroundModeEnabled = request.Background,
                    StoredOutputEnabled = request.Store
                };
                createOptions.InputItems.Add(ResponseItem.CreateUserMessageItem(request.Input));
                var content = (BinaryContent)createOptions;
                var requestOptions = new RequestOptions();
                requestOptions.SetHeader("Idempotency-Key", request.IdempotencyKey);
                requestOptions.CancellationToken = token;
                var raw = await client.CreateResponseAsync(content, requestOptions);
                return ResponsesRuntimeMapping.Map((ResponseResult)raw);
            },
            responsesOptions.Value,
            cancellationToken);
    }

    public async Task<ResponsesResult> RetrieveAsync(
        string responseId,
        CancellationToken cancellationToken)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(responseId);
        return await ResponsesRuntimeRetry.ExecuteAsync(
            async token =>
            {
                var client = clientFactory.Create(responsesOptions.Value.Model);
                var result = await client.GetResponseAsync(responseId, token);
                return ResponsesRuntimeMapping.Map(result.Value);
            },
            responsesOptions.Value,
            cancellationToken);
    }

    public async Task<ResponsesResult> CancelAsync(
        string responseId,
        CancellationToken cancellationToken)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(responseId);
        return await ResponsesRuntimeRetry.ExecuteAsync(
            async token =>
            {
                var client = clientFactory.Create(responsesOptions.Value.Model);
                var result = await client.CancelResponseAsync(responseId, token);
                return ResponsesRuntimeMapping.Map(result.Value);
            },
            responsesOptions.Value,
            cancellationToken);
    }
}

public interface IResponsesClientFactory
{
    ResponsesClient Create(string model);
}

public sealed class OpenAiResponsesClientFactory(
    IOptions<OpenAiRealtimeOptions> options,
    IPhase9bBudgetAdmission admission) : IResponsesClientFactory, IDisposable
{
    private readonly HttpClient? httpClient = admission.Enabled
        ? Phase9bProviderHttpClient.Create(admission)
        : null;

    public ResponsesClient Create(string model)
    {
        var settings = options.Value;
        var clientOptions = new ResponsesClientOptions
        {
            Endpoint = new Uri(settings.BaseUrl, UriKind.Absolute)
        };
        if (httpClient is not null)
        {
            clientOptions.Transport = new HttpClientPipelineTransport(httpClient);
        }

        return new ResponsesClient(new ApiKeyCredential(settings.ApiKey), clientOptions);
    }

    public void Dispose() => httpClient?.Dispose();
}

internal static class ResponsesRuntimeMapping
{
    public static ResponsesResult Map(ResponseResult response)
    {
        var status = response.Status switch
        {
            ResponseStatus.Queued => ResponsesStatus.Queued,
            ResponseStatus.InProgress => ResponsesStatus.InProgress,
            ResponseStatus.Completed => ResponsesStatus.Completed,
            ResponseStatus.Failed => ResponsesStatus.Failed,
            ResponseStatus.Cancelled => ResponsesStatus.Cancelled,
            ResponseStatus.Incomplete => ResponsesStatus.Incomplete,
            _ => ResponsesStatus.Unknown
        };
        return new(
            response.Id,
            status,
            status == ResponsesStatus.Completed ? response.GetOutputText() : null,
            response.Error?.Code.ToString(),
            response.Error?.Message);
    }
}

internal static class ResponsesRuntimeRetry
{
    public static async Task<T> ExecuteAsync<T>(
        Func<CancellationToken, Task<T>> operation,
        ResponsesOptions settings,
        CancellationToken cancellationToken)
    {
        var maxAttempts = Math.Clamp(settings.MaxTransientRetries, 0, 3) + 1;
        for (var attempt = 1; ; attempt++)
        {
            using var timeout = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
            timeout.CancelAfter(TimeSpan.FromSeconds(Math.Clamp(settings.TimeoutSeconds, 1, 600)));
            try
            {
                return await operation(timeout.Token);
            }
            catch (ClientResultException exception) when (attempt < maxAttempts && IsTransient(exception))
            {
                await Task.Delay(TimeSpan.FromMilliseconds(50L * attempt), cancellationToken);
            }
            catch (HttpRequestException exception) when (attempt < maxAttempts && IsTransient(exception))
            {
                await Task.Delay(TimeSpan.FromMilliseconds(50L * attempt), cancellationToken);
            }
            catch (OperationCanceledException) when (!cancellationToken.IsCancellationRequested && attempt < maxAttempts)
            {
                await Task.Delay(TimeSpan.FromMilliseconds(50L * attempt), cancellationToken);
            }
        }
    }

    public static async Task<T> ExecuteCreateOnlyAsync<T>(
        Func<CancellationToken, Task<T>> operation,
        ResponsesOptions settings,
        CancellationToken cancellationToken)
    {
        var maxAttempts = Math.Clamp(settings.MaxTransientRetries, 0, 3) + 1;
        for (var attempt = 1; ; attempt++)
        {
            using var timeout = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
            timeout.CancelAfter(TimeSpan.FromSeconds(Math.Clamp(settings.TimeoutSeconds, 1, 600)));
            try
            {
                return await operation(timeout.Token);
            }
            catch (ClientResultException exception) when (attempt < maxAttempts && exception.Status == 429)
            {
                // A rejected 429 is the only create failure that is safe to
                // retry. Network, timeout, and server failures have unknown
                // execution outcomes for this stateless provider.
                await Task.Delay(TimeSpan.FromMilliseconds(50L * attempt), cancellationToken);
            }
        }
    }

    private static bool IsTransient(int status) => status == 429 || status >= 500;

    private static bool IsTransient(ClientResultException exception) =>
        IsTransient(exception.Status)
        || exception.InnerException is HttpRequestException networkException
            && IsTransient(networkException);

    private static bool IsTransient(HttpRequestException exception) =>
        exception.StatusCode is null || IsTransient((int)exception.StatusCode.Value);
}
