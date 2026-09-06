using Jarvis.DeviceNode;
using Jarvis.DeviceNode.Codex;
using Microsoft.Extensions.Configuration;
using Xunit;

namespace Jarvis.DeviceNode.Tests;

public sealed class CodexProtocolTests
{
    [Fact]
    public void BoundConfiguredArgumentIsPassedOnce()
    {
        var configuration = new ConfigurationBuilder()
            .AddInMemoryCollection(new Dictionary<string, string?>
            {
                ["DeviceNode:CodexArguments:0"] = "app-server"
            })
            .Build();
        var options = new DeviceNodeOptions();
        configuration.GetSection(DeviceNodeOptions.SectionName).Bind(options);

        var runtime = new CodexRuntimeOptions("pinned-codex", options.CodexArguments);

        Assert.Equal(["app-server"], options.CodexArguments);
        Assert.Equal(["app-server"], runtime.EffectiveArguments);
    }

    [Fact]
    public void MissingConfiguredArgumentsUseTheSingleDefaultCommand()
    {
        var configuration = new ConfigurationBuilder().Build();
        var options = new DeviceNodeOptions();
        configuration.GetSection(DeviceNodeOptions.SectionName).Bind(options);

        var runtime = new CodexRuntimeOptions("pinned-codex", options.CodexArguments);

        Assert.Empty(options.CodexArguments);
        Assert.Equal(["app-server"], runtime.EffectiveArguments);
    }

    [Fact]
    public void ExplicitArgumentsPreserveOrderAndValues()
    {
        var arguments = new[] { "app-server", "--strict-config", "-c", "model=x" };

        var runtime = new CodexRuntimeOptions("pinned-codex", arguments);

        Assert.Equal(arguments, runtime.EffectiveArguments);
    }
}
