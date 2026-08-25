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
        long nowMs)
    {
        Id = id;
        UserId = userId;
        Name = name;
        DeviceType = deviceType;
        Platform = platform;
        CapabilitiesJson = capabilitiesJson;
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

    public DeviceStatus Status { get; private set; }

    public long? LastSeenAtMs { get; private set; }

    public long PairedAtMs { get; private set; }

    public long Version { get; private set; }

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

        return new Device(id, userId, name.Trim(), deviceType, platform.Trim(), capabilitiesJson, nowMs);
    }
}
