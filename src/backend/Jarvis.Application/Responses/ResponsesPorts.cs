namespace Jarvis.Application.Responses;

public enum ResponsesStatus
{
    Queued,
    InProgress,
    Completed,
    Failed,
    Cancelled,
    Incomplete,
    Unknown
}

public sealed record ResponsesCreateRequest(
    string Model,
    string Instructions,
    string Input,
    string IdempotencyKey,
    bool Background = true,
    bool Store = true);

public sealed record ResponsesResult(
    string? ResponseId,
    ResponsesStatus Status,
    string? OutputText = null,
    string? ErrorCode = null,
    string? ErrorMessage = null)
{
    public bool IsTerminal => Status is ResponsesStatus.Completed
        or ResponsesStatus.Failed
        or ResponsesStatus.Cancelled
        or ResponsesStatus.Incomplete;
}

public interface IResponsesRuntime
{
    Task<ResponsesResult> CreateAsync(
        ResponsesCreateRequest request,
        CancellationToken cancellationToken);
}

public interface IStoredResponsesRuntime : IResponsesRuntime
{
    Task<ResponsesResult> RetrieveAsync(
        string responseId,
        CancellationToken cancellationToken);

    Task<ResponsesResult> CancelAsync(
        string responseId,
        CancellationToken cancellationToken);
}
