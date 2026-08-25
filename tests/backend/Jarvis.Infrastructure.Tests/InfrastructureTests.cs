using Jarvis.Infrastructure;
using Xunit;

namespace Jarvis.Infrastructure.Tests;

public sealed class InfrastructureTests
{
    [Fact]
    public void InfrastructureAssemblyMarkerIsAvailable()
    {
        Assert.NotNull(typeof(InfrastructureAssemblyMarker).Assembly);
    }
}
