using Jarvis.Application.Realtime;
using Microsoft.Extensions.Options;

namespace Jarvis.Infrastructure.Realtime;

public sealed class WakeWordOptions
{
    public const string SectionName = "WakeWord";

    public bool Enabled { get; set; } = true;

    public string Keyword { get; set; } = "Jarvis";

    public string? PicovoiceAccessKey { get; set; }
}

public sealed class ConfiguredWakeWordConfigurationProvider(
    IOptions<WakeWordOptions> options) : IWakeWordConfigurationProvider
{
    public WakeWordConfiguration GetRequired()
    {
        var settings = options.Value;
        if (string.IsNullOrWhiteSpace(settings.PicovoiceAccessKey))
        {
            throw new WakeWordConfigurationException(
                "WakeWord:PicovoiceAccessKey is required for Desktop Realtime bootstrap. Configure it with ASP.NET Core User Secrets.");
        }

        return new WakeWordConfiguration(
            settings.Enabled,
            settings.Keyword,
            settings.PicovoiceAccessKey.Trim());
    }
}
