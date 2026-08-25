namespace Jarvis.Domain.Identity;

public sealed class User
{
    private User()
    {
    }

    private User(Guid id, string displayName, string locale, string timeZone, long nowMs)
    {
        Id = id;
        DisplayName = displayName;
        Locale = locale;
        TimeZone = timeZone;
        CreatedAtMs = nowMs;
        UpdatedAtMs = nowMs;
    }

    public Guid Id { get; private set; }

    public string DisplayName { get; private set; } = string.Empty;

    public string Locale { get; private set; } = string.Empty;

    public string TimeZone { get; private set; } = string.Empty;

    public long CreatedAtMs { get; private set; }

    public long UpdatedAtMs { get; private set; }

    public long Version { get; private set; }

    public static User Create(Guid id, string displayName, string locale, string timeZone, long nowMs)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(displayName);
        ArgumentException.ThrowIfNullOrWhiteSpace(locale);
        ArgumentException.ThrowIfNullOrWhiteSpace(timeZone);

        return new User(id, displayName.Trim(), locale.Trim(), timeZone.Trim(), nowMs);
    }
}
