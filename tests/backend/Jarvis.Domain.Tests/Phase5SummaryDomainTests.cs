using Jarvis.Domain.Conversations;
using Xunit;

namespace Jarvis.Domain.Tests;

public sealed class Phase5SummaryDomainTests
{
    [Fact]
    public void ConversationCanAdvanceToAnImmutableSummary()
    {
        var conversation = Conversation.Create(Guid.CreateVersion7(), Guid.CreateVersion7(), "summary", 10);
        var summary = ConversationSummary.Create(
            Guid.CreateVersion7(),
            conversation.Id,
            1,
            3,
            "A concise summary.",
            "summarizer",
            20);

        conversation.SetCurrentSummary(summary.Id);

        Assert.Equal(summary.Id, conversation.CurrentSummaryId);
        Assert.Equal(1, summary.FromSequence);
        Assert.Equal(3, summary.ToSequence);
    }
}
