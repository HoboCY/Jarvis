using Jarvis.Application.Responses;
using Jarvis.Infrastructure.Realtime;
using Microsoft.Extensions.Options;

namespace Jarvis.Infrastructure.Responses;

public sealed class OpenAiSummaryProvider(
    IResponsesRuntime runtime,
    IOptions<OpenAiRealtimeOptions> options) : ISummaryProvider
{
    public async Task<string> SummarizeAsync(
        SummaryRequest request,
        CancellationToken cancellationToken)
    {
        var stableKey = $"jarvis-summary:{request.ConversationId:D}:{request.FromSequence}:{request.ToSequence}";
        var delta = string.Join(
            "\n",
            request.Messages.Select(message => $"{message.Role} [{message.Sequence}]: {message.Text}"));
        var input = string.IsNullOrWhiteSpace(request.PreviousSummary)
            ? delta
            : $"Previous cumulative summary:\n{request.PreviousSummary}\n\nNew conversation messages:\n{delta}";
        var result = await runtime.CreateAsync(
            new ResponsesCreateRequest(
                options.Value.SummarizerModel,
                "Summarize the supplied conversation faithfully and concisely. Preserve decisions, preferences, open questions, and commitments. Return only the summary text.",
                input,
                stableKey,
                Background: false,
                Store: true),
            cancellationToken);

        for (var attempt = 0; ; attempt++)
        {
            if (result.Status == ResponsesStatus.Completed && !string.IsNullOrWhiteSpace(result.OutputText))
            {
                return result.OutputText.Trim();
            }

            if (result.Status is ResponsesStatus.Failed or ResponsesStatus.Cancelled or ResponsesStatus.Incomplete or ResponsesStatus.Unknown)
            {
                throw new InvalidOperationException(
                    result.ErrorMessage ?? "The Responses provider could not create a conversation summary.");
            }

            if (string.IsNullOrWhiteSpace(result.ResponseId) || attempt >= 120)
            {
                throw new InvalidOperationException("The Responses provider did not finish the conversation summary.");
            }

            await Task.Delay(
                Math.Clamp(options.Value.ResponsesPollingIntervalMs, 25, 5_000),
                cancellationToken);
            result = await runtime.RetrieveAsync(result.ResponseId, cancellationToken);
        }
    }
}
