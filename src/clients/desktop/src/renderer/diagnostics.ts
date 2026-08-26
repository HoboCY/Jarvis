export type DesktopDiagnostics = {
  version: string;
  uptimeSeconds: number;
  databaseAvailable: boolean;
  tasksByStatus: Record<string, number>;
  pendingApprovals: number;
  unreadNotifications: number;
  pendingOutbox: number;
  onlineDevices: number;
  workers: Record<string, string>;
  circuits: Record<string, string>;
};

export function parseDiagnostics(value: unknown): DesktopDiagnostics {
  const item = asRecord(value);
  const database = asRecord(item.database);
  const work = asRecord(item.work);
  return {
    version: boundedString(item.version, "version", 100),
    uptimeSeconds: boundedNumber(item.uptimeSeconds, "uptimeSeconds"),
    databaseAvailable: requiredBoolean(database.available, "database.available"),
    tasksByStatus: boundedNumberMap(work.tasksByStatus, "work.tasksByStatus"),
    pendingApprovals: boundedNumber(work.pendingApprovals, "work.pendingApprovals"),
    unreadNotifications: boundedNumber(work.unreadNotifications, "work.unreadNotifications"),
    pendingOutbox: boundedNumber(work.pendingOutbox, "work.pendingOutbox"),
    onlineDevices: boundedNumber(work.onlineDevices, "work.onlineDevices"),
    workers: boundedStringMap(item.workers, "workers"),
    circuits: boundedStringMap(item.circuits, "circuits")
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Backend returned an invalid diagnostics response.");
  }
  return value as Record<string, unknown>;
}

function boundedString(value: unknown, name: string, maxLength: number): string {
  if (typeof value !== "string" || value.length === 0 || value.length > maxLength) {
    throw new Error(`Backend returned an invalid ${name}.`);
  }
  return value;
}

function boundedNumber(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 || value > 2_000_000_000) {
    throw new Error(`Backend returned an invalid ${name}.`);
  }
  return value;
}

function requiredBoolean(value: unknown, name: string): boolean {
  if (typeof value !== "boolean") {
    throw new Error(`Backend returned an invalid ${name}.`);
  }
  return value;
}

function boundedNumberMap(value: unknown, name: string): Record<string, number> {
  const map = asRecord(value);
  const result: Record<string, number> = {};
  for (const [key, entry] of Object.entries(map).slice(0, 32)) {
    result[boundedString(key, `${name} key`, 64)] = boundedNumber(entry, `${name}.${key}`);
  }
  return result;
}

function boundedStringMap(value: unknown, name: string): Record<string, string> {
  const map = asRecord(value);
  const result: Record<string, string> = {};
  for (const [key, entry] of Object.entries(map).slice(0, 32)) {
    result[boundedString(key, `${name} key`, 64)] = boundedString(entry, `${name}.${key}`, 64);
  }
  return result;
}
