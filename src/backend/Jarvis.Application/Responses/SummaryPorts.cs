namespace Jarvis.Application.Responses;

public sealed record SummaryInputMessage(string Role, string Text, long Sequence);

public sealed record SummaryRequest(
    Guid ConversationId,
    long FromSequence,
    long ToSequence,
    IReadOnlyList<SummaryInputMessage> Messages,
    string PreviousSummary = "",
    Guid? CurrentSummaryId = null);

public interface ISummaryProvider
{
    Task<string> SummarizeAsync(
        SummaryRequest request,
        CancellationToken cancellationToken);
}
