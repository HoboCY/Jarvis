using Xunit;

namespace Jarvis.Api.IntegrationTests;

public sealed class ApiTests
{
    [Fact]
    public void ApiAssemblyIsLoadable()
    {
        var apiAssembly = typeof(Program).Assembly;

        Assert.Equal("Jarvis.Api", apiAssembly.GetName().Name);
    }
}
