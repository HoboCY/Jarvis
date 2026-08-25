using Jarvis.Domain;
using Xunit;

namespace Jarvis.Domain.Tests;

public sealed class DomainTests
{
    [Fact]
    public void DomainAssemblyMarkerIsAvailable()
    {
        Assert.NotNull(typeof(DomainAssemblyMarker).Assembly);
    }
}
