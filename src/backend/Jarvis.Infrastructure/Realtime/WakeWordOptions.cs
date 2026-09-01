using Jarvis.Application.Realtime;
using Microsoft.Extensions.Options;

namespace Jarvis.Infrastructure.Realtime;

public sealed class WakeWordOptions
{
    public const string SectionName = "WakeWord";

    public bool Enabled { get; set; } = true;

    public string Keyword { get; set; } = "贾维斯";
}

public sealed class ConfiguredWakeWordConfigurationProvider(
    IOptions<WakeWordOptions> options) : IWakeWordConfigurationProvider
{
    public WakeWordConfiguration GetRequired()
    {
        var settings = options.Value;
        return new WakeWordConfiguration(
            settings.Enabled,
            settings.Keyword);
    }
}
