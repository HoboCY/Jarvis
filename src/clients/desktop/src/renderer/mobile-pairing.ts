export type MobilePairing = { code: string; expiresAtMs: number };

export type DesktopMobilePairingInput = {
  deviceName: string;
  platform: string;
  capabilities: string[];
  idempotencyKey: string;
};

export function buildDesktopMobilePairingInput(idempotencyKey: string): DesktopMobilePairingInput {
  const normalized = idempotencyKey.trim();
  if (!normalized || normalized.length > 200) {
    throw new Error("A bounded mobile pairing idempotency key is required.");
  }
  return {
    deviceName: "Jarvis Mobile",
    platform: "desktop",
    capabilities: ["microphone", "notifications"],
    idempotencyKey: normalized
  };
}

export function mobilePairingFrom(value: unknown): MobilePairing {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Backend returned an invalid mobile pairing response.");
  }
  const item = value as Record<string, unknown>;
  if (typeof item.code !== "string" || item.code.trim().length < 32
    || typeof item.expiresAtMs !== "number" || !Number.isFinite(item.expiresAtMs)) {
    throw new Error("Backend returned an invalid mobile pairing code.");
  }
  return { code: item.code, expiresAtMs: item.expiresAtMs };
}
