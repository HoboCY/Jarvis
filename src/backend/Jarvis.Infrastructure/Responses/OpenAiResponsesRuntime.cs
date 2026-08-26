using System.ClientModel;
using System.ClientModel.Primitives;
using Jarvis.Application.Responses;
using Jarvis.Infrastructure.Realtime;
using Microsoft.Extensions.Options;
using OpenAI.Responses;

namespace Jarvis.Infrastructure.Responses;

/// <summary>
/// Infrastructure-only adapter around the official OpenAI Responses SDK. The
/// application sees only the small <see cref="IResponsesRuntime"/> port.
/// </summary>
public sealed class OpenAiResponsesRuntime(
    IOptions<OpenAiRealtimeOptions> options,
    IResponsesClientFactory clientFactory) : IResponsesRuntime
{
    public OpenAiResponsesRuntime(IOptions<OpenAiRealtimeOptions> options)
        : this(options, new OpenAiResponsesClientFactory(options))
    {
    }

    public async Task<ResponsesResult> CreateAsync(
        ResponsesCreateRequest request,
        CancellationToken cancellationToken)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(request.Model);
        ArgumentException.ThrowIfNullOrWhiteSpace(request.Input);
        ArgumentException.ThrowIfNullOrWhiteSpace(request.IdempotencyKey);

        return await ExecuteWithRetryAsync(
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
                return Map((ResponseResult)raw);
            },
            cancellationToken);
    }

    public async Task<ResponsesResult> RetrieveAsync(
        string responseId,
        CancellationToken cancellationToken)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(responseId);
        return await ExecuteWithRetryAsync(
            async token =>
            {
                var client = clientFactory.Create(options.Value.ResponsesModel);
                var result = await client.GetResponseAsync(responseId, token);
                return Map(result.Value);
            },
            cancellationToken);
    }

    public async Task<ResponsesResult> CancelAsync(
        string responseId,
        CancellationToken cancellationToken)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(responseId);
        return await ExecuteWithRetryAsync(
            async token =>
            {
                var client = clientFactory.Create(options.Value.ResponsesModel);
                var result = await client.CancelResponseAsync(responseId, token);
                return Map(result.Value);
            },
            cancellationToken);
    }

    private async Task<ResponsesResult> ExecuteWithRetryAsync(
        Func<CancellationToken, Task<ResponsesResult>> operation,
        CancellationToken cancellationToken)
    {
        var settings = options.Value;
        var maxAttempts = Math.Clamp(settings.ResponsesMaxTransientRetries, 0, 3) + 1;
        for (var attempt = 1; ; attempt++)
        {
            using var timeout = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
            timeout.CancelAfter(TimeSpan.FromSeconds(Math.Clamp(settings.ResponsesTimeoutSeconds, 1, 600)));
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

    private static bool IsTransient(int status) => status == 429 || status >= 500;

    private static bool IsTransient(ClientResultException exception) =>
        IsTransient(exception.Status)
        || exception.InnerException is HttpRequestException networkException
            && IsTransient(networkException);

    private static bool IsTransient(HttpRequestException exception) =>
        exception.StatusCode is null || IsTransient((int)exception.StatusCode.Value);

    private static ResponsesResult Map(ResponseResult response)
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

public interface IResponsesClientFactory
{
    ResponsesClient Create(string model);
}

public sealed class OpenAiResponsesClientFactory(
    IOptions<OpenAiRealtimeOptions> options) : IResponsesClientFactory
{
    public ResponsesClient Create(string model)
    {
        var settings = options.Value;
        return new ResponsesClient(
            new ApiKeyCredential(settings.ApiKey),
            new ResponsesClientOptions
            {
                Endpoint = new Uri(settings.BaseUrl, UriKind.Absolute)
            });
    }
}
