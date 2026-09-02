export type DesktopDeviceType = "desktop" | "mobile" | "server";
export type DesktopDeviceStatus = "online" | "offline" | "disabled";

export type DesktopDevice = {
  deviceId: string;
  name: string;
  deviceType: DesktopDeviceType;
  platform: string;
  status: DesktopDeviceStatus;
};

const deviceTypes = new Set<DesktopDeviceType>(["desktop", "mobile", "server"]);
const deviceStatuses = new Set<DesktopDeviceStatus>(["online", "offline", "disabled"]);

function requiredString(value: unknown, maximumLength: number): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const normalized = value.trim();
  return normalized.length > 0 && normalized.length <= maximumLength ? normalized : undefined;
}

export function parseDesktopDeviceBootstrap(value: unknown): DesktopDevice {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Backend returned an invalid Desktop device.");
  }
  const item = value as Record<string, unknown>;
  const deviceId = requiredString(item.deviceId, 200);
  const name = requiredString(item.name, 200);
  const platform = requiredString(item.platform, 64);
  const deviceType = item.deviceType;
  const status = item.status;
  if (!deviceId || !name || !platform
    || typeof deviceType !== "string"
    || !deviceTypes.has(deviceType as DesktopDeviceType)
    || typeof status !== "string"
    || !deviceStatuses.has(status as DesktopDeviceStatus)) {
    throw new Error("Backend returned an invalid Desktop device.");
  }
  return {
    deviceId,
    name,
    platform,
    deviceType: deviceType as DesktopDeviceType,
    status: status as DesktopDeviceStatus
  };
}

export function desktopDeviceStatusLabel(device: Pick<DesktopDevice, "status">): string {
  switch (device.status) {
    case "online": return "在线";
    case "offline": return "离线";
    case "disabled": return "已禁用";
  }
}

export function desktopDeviceAudioLabel(device: DesktopDevice): string {
  if (device.deviceType !== "desktop") {
    return `${device.name} 不是 Desktop 设备，语音不可用`;
  }
  if (device.status === "disabled") {
    return `${device.name} 已禁用，语音不可用`;
  }
  return `音频在 ${device.name} 本机处理`;
}

export function desktopDeviceCanUseLocalAudio(device: DesktopDevice): boolean {
  return device.deviceType === "desktop" && device.status !== "disabled";
}
