type RandomSource = {
  randomUUID?: () => string;
  getRandomValues?: (values: Uint8Array) => Uint8Array;
};

let fallbackSequence = 0;

/**
 * Hermes does not promise Node's crypto module or randomUUID. Prefer the
 * runtime Web Crypto surface when available and retain a unique fallback for
 * non-secret request/event identifiers.
 */
export function createMobileUuid(): string {
  const source = readRandomSource();
  if (source?.randomUUID) {
    return source.randomUUID();
  }

  const bytes = new Uint8Array(16);
  if (source?.getRandomValues) {
    source.getRandomValues(bytes);
  } else {
    fillFallbackBytes(bytes);
  }
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  return formatUuid(bytes);
}

export function createMobileIdempotencyKey(prefix: string): string {
  const normalizedPrefix = prefix.trim();
  if (!normalizedPrefix) {
    throw new Error("An idempotency key prefix is required.");
  }
  return `${normalizedPrefix}-${createMobileUuid()}`;
}

function readRandomSource(): RandomSource | undefined {
  const value = (globalThis as { crypto?: unknown }).crypto;
  if (typeof value !== "object" || value === null) {
    return undefined;
  }
  const candidate = value as Record<string, unknown>;
  return typeof candidate.randomUUID === "function" || typeof candidate.getRandomValues === "function"
    ? {
      ...(typeof candidate.randomUUID === "function"
        ? { randomUUID: (candidate.randomUUID as () => string).bind(value) }
        : {}),
      ...(typeof candidate.getRandomValues === "function"
        ? { getRandomValues: (candidate.getRandomValues as (values: Uint8Array) => Uint8Array).bind(value) }
        : {})
    }
    : undefined;
}

function fillFallbackBytes(bytes: Uint8Array): void {
  let state = (Date.now() ^ (++fallbackSequence * 0x9e3779b9)) >>> 0;
  for (let index = 0; index < bytes.length; index++) {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    bytes[index] = state & 0xff;
  }
}

function formatUuid(bytes: Uint8Array): string {
  const hex = [...bytes].map(value => value.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
