export type BackendConnectionStateValue =
  | "connecting"
  | "connected"
  | "reconnecting"
  | "disconnected";

export type BackendConnectionState = {
  state: BackendConnectionStateValue;
  revision: number;
};

export const initialBackendConnectionState: BackendConnectionState = {
  state: "connecting",
  revision: -1
};

const validStates = new Set<BackendConnectionStateValue>([
  "connecting",
  "connected",
  "reconnecting",
  "disconnected"
]);

export function applyBackendConnectionState(
  current: BackendConnectionState,
  value: unknown
): BackendConnectionState {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Invalid backend connection state.");
  }

  const item = value as Record<string, unknown>;
  if (typeof item.state !== "string"
    || !validStates.has(item.state as BackendConnectionStateValue)
    || typeof item.revision !== "number"
    || !Number.isSafeInteger(item.revision)
    || item.revision < 0) {
    throw new Error("Invalid backend connection state.");
  }

  if (item.revision < current.revision) {
    return current;
  }

  return {
    state: item.state as BackendConnectionStateValue,
    revision: item.revision
  };
}
