using Jarvis.Application.Tasks;
using Jarvis.Domain.Tasks;
using Xunit;

namespace Jarvis.Application.Tests;

public sealed class WorkerRouterTests
{
    [Theory]
    [InlineData("localFiles", "deepReasoning", WorkerKind.Codex)]
    [InlineData("writeFiles", "networkResearch", WorkerKind.Codex)]
    [InlineData("deepReasoning", WorkerKind.Responses)]
    [InlineData("networkResearch", WorkerKind.Responses)]
    [InlineData("", WorkerKind.Internal)]
    public void RoutesDeterministicallyWithLocalCapabilitiesTakingPriority(params object[] values)
    {
        var expected = (WorkerKind)values[^1];
        var capabilities = values[..^1].Cast<string>();

        Assert.Equal(expected, WorkerRouter.Route(capabilities));
    }

    [Fact]
    public void UnknownCapabilityIsRejected()
    {
        var exception = Assert.Throws<ArgumentException>(() => WorkerRouter.Route(["secretShell"]));

        Assert.Contains("secretShell", exception.Message, StringComparison.Ordinal);
    }
}
