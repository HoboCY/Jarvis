using System.ClientModel;
using System.ClientModel.Primitives;
using Jarvis.Application.Responses;
using Microsoft.Extensions.Options;
using OpenAI.Responses;

namespace Jarvis.Infrastructure.Responses;

/// <summary>
/// Synchronous DeepSeek Responses adapter. DeepSeek's Responses API is
/// stateless, so it deliberately implements create only and never exposes
/// retrieve or cancel operations.
/// </summary>
public sealed class DeepSeekResponsesRuntime : IResponsesRuntime
{
    private readonly IOptions<ResponsesOptions> responsesOptions;
    private readonly IResponsesClientFactory clientFactory;

    public DeepSeekResponsesRuntime(
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

        return await ResponsesRuntimeRetry.ExecuteCreateOnlyAsync(
            async token =>
            {
                var client = clientFactory.Create(request.Model);
                var createOptions = new CreateResponseOptions
                {
                    Model = request.Model,
                    Instructions = request.Instructions,
                    BackgroundModeEnabled = false,
                    StoredOutputEnabled = false
                };
                createOptions.InputItems.Add(ResponseItem.CreateUserMessageItem(request.Input));
                var content = (BinaryContent)createOptions;
                var requestOptions = new RequestOptions();
                requestOptions.SetHeader("Idempotency-Key", request.IdempotencyKey);
                requestOptions.CancellationToken = token;
                var raw = await client.CreateResponseAsync(content, requestOptions);
                var result = ResponsesRuntimeMapping.Map((ResponseResult)raw);
                return result.IsTerminal
                    ? result
                    : result with
                    {
                        Status = ResponsesStatus.Failed,
                        ErrorCode = "responses_sync_non_terminal",
                        ErrorMessage = "The synchronous Responses provider returned a non-terminal response."
                    };
            },
            responsesOptions.Value,
            cancellationToken);
    }
}

public sealed class DeepSeekResponsesClientFactory(
    IOptions<DeepSeekOptions> options) : IResponsesClientFactory
{
    public ResponsesClient Create(string model)
    {
        var settings = options.Value;
        return new ResponsesClient(
            new ApiKeyCredential(settings.ApiKey),
            new ResponsesClientOptions
            {
                Endpoint = new Uri(settings.BaseUrl, UriKind.Absolute),
                RetryPolicy = new ClientRetryPolicy(0)
            });
    }
}
