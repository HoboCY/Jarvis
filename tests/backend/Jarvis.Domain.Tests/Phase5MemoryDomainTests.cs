using Jarvis.Domain.Memory;
using Xunit;

namespace Jarvis.Domain.Tests;

public sealed class Phase5MemoryDomainTests
{
    [Fact]
    public void DirectMemoryFactStartsActiveWithFullConfidence()
    {
        var nowMs = 1234L;
        var fact = MemoryFact.CreateDirect(
            Guid.CreateVersion7(),
            Guid.CreateVersion7(),
            "communication.responseLength",
            "prefer concise answers",
            Guid.CreateVersion7(),
            sensitive: false,
            nowMs);

        Assert.Equal(MemoryFactStatus.Active, fact.Status);
        Assert.Equal(1d, fact.Confidence);
        Assert.Equal(nowMs, fact.LastConfirmedAtMs);
        Assert.Null(fact.SupersedesMemoryId);
    }
}
