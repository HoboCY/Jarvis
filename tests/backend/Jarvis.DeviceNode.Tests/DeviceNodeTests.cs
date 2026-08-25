using Jarvis.DeviceNode;
using Xunit;

namespace Jarvis.DeviceNode.Tests;

public sealed class DeviceNodeTests
{
    [Fact]
    public void DeviceNodeAssemblyMarkerIsAvailable()
    {
        Assert.NotNull(typeof(DeviceNodeAssemblyMarker).Assembly);
    }
}
