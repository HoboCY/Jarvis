using Jarvis.Application;
using Xunit;

namespace Jarvis.Application.Tests;

public sealed class ApplicationTests
{
    [Fact]
    public void ApplicationAssemblyMarkerIsAvailable()
    {
        Assert.NotNull(typeof(ApplicationAssemblyMarker).Assembly);
    }
}
