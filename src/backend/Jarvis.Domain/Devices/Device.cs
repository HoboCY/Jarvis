namespace Jarvis.Domain.Devices;

public enum DeviceType
{
    Desktop,
    Mobile,
    Server
}

public enum DeviceStatus
{
    Online,
    Offline,
    Disabled
}

public sealed class Device
{
    private Device()
    {
    }

    private Device(
        Guid id,
        Guid userId,
        string name,
        DeviceType deviceType,
        string platform,
        string capabilitiesJson,
        string allowedRootsJson,
        string? credentialHash,
        long nowMs)
    {
        Id = id;
        UserId = userId;
        Name = name;
        DeviceType = deviceType;
        Platform = platform;
        CapabilitiesJson = capabilitiesJson;
        AllowedRootsJson = allowedRootsJson;
        CredentialHash = credentialHash;
        Status = DeviceStatus.Offline;
        LastSeenAtMs = null;
        PairedAtMs = nowMs;
    }

    public Guid Id { get; private set; }

    public Guid UserId { get; private set; }

    public string Name { get; private set; } = string.Empty;

    public DeviceType DeviceType { get; private set; }

    public string Platform { get; private set; } = string.Empty;

    public string CapabilitiesJson { get; private set; } = "{}";

    public string AllowedRootsJson { get; private set; } = "[]";

    /// <summary>Only a one-way hash is persisted. The raw credential is returned once at registration.</summary>
    public string? CredentialHash { get; private set; }

    public DeviceStatus Status { get; private set; }

    public long? LastSeenAtMs { get; private set; }

    public long PairedAtMs { get; private set; }

    public long Version { get; private set; }

    public bool CanAuthenticate => Status != DeviceStatus.Disabled && !string.IsNullOrWhiteSpace(CredentialHash);

    public static Device Create(
        Guid id,
        Guid userId,
        string name,
        DeviceType deviceType,
        string platform,
        string capabilitiesJson,
        long nowMs)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(name);
        ArgumentException.ThrowIfNullOrWhiteSpace(platform);
        ArgumentException.ThrowIfNullOrWhiteSpace(capabilitiesJson);

        return new Device(id, userId, name.Trim(), deviceType, platform.Trim(), capabilitiesJson, "[]", null, nowMs);
    }

    public static Device Register(
        Guid id,
        Guid userId,
        string name,
        DeviceType deviceType,
        string platform,
        string capabilitiesJson,
        string credentialHash,
        long nowMs,
        string allowedRootsJson = "[]")
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(name);
        ArgumentException.ThrowIfNullOrWhiteSpace(platform);
        ArgumentException.ThrowIfNullOrWhiteSpace(capabilitiesJson);
        ArgumentException.ThrowIfNullOrWhiteSpace(credentialHash);
        ArgumentException.ThrowIfNullOrWhiteSpace(allowedRootsJson);
        var device = new Device(id, userId, name.Trim(), deviceType, platform.Trim(), capabilitiesJson, allowedRootsJson, credentialHash.Trim(), nowMs);
        return device;
    }

    public bool Heartbeat(string capabilitiesJson, long nowMs, string? allowedRootsJson = null)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(capabilitiesJson);
        if (Status == DeviceStatus.Disabled)
        {
            return false;
        }

        CapabilitiesJson = capabilitiesJson;
        if (allowedRootsJson is not null)
        {
            ArgumentException.ThrowIfNullOrWhiteSpace(allowedRootsJson);
            AllowedRootsJson = allowedRootsJson;
        }
        Status = DeviceStatus.Online;
        LastSeenAtMs = nowMs;
        Version++;
        return true;
    }

    public bool Disable(long nowMs)
    {
        if (Status == DeviceStatus.Disabled)
        {
            return false;
        }

        Status = DeviceStatus.Disabled;
        LastSeenAtMs = nowMs;
        Version++;
        return true;
    }

    public bool MarkOffline(long nowMs)
    {
        if (Status == DeviceStatus.Disabled || Status == DeviceStatus.Offline)
        {
            return false;
        }

        Status = DeviceStatus.Offline;
        LastSeenAtMs = nowMs;
        Version++;
        return true;
    }
}
