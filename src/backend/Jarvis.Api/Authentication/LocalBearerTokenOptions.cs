namespace Jarvis.Api.Authentication;

public sealed class LocalBearerTokenOptions
{
    public const string SectionName = "Authentication";

    public string BearerToken { get; set; } = string.Empty;
}
