using System.Net;

namespace Jarvis.Api.Diagnostics;

public sealed class DiagnosticsOptions
{
    public const string SectionName = "Diagnostics";

    public bool Enabled { get; set; } = true;

    public bool RequireLoopback { get; set; } = true;

    public bool AllowTestServerLoopback { get; set; }

    /// <summary>
    /// Testing-only connection address override. It is ignored outside the
    /// Testing environment and cannot be supplied by an HTTP header.
    /// </summary>
    public string? TestServerRemoteAddress { get; set; }

    public bool IsLoopback(HttpContext context, IHostEnvironment environment)
    {
        if (!RequireLoopback)
        {
            return false;
        }

        var remote = context.Connection.RemoteIpAddress;
        if (environment.IsEnvironment("Testing")
            && IPAddress.TryParse(TestServerRemoteAddress, out var testRemote))
        {
            remote = testRemote;
        }
        if (remote is not null && IPAddress.IsLoopback(remote))
        {
            return true;
        }

        return environment.IsEnvironment("Testing") && AllowTestServerLoopback && remote is null;
    }
}
