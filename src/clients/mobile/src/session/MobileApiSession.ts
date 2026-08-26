export type StoredMobileRefreshCredential = {
  sessionId: string;
  refreshToken: string;
  refreshTokenExpiresAtMs: number;
};

export interface MobileCredentialStore {
  load: () => Promise<StoredMobileRefreshCredential | null>;
  save: (credential: StoredMobileRefreshCredential) => Promise<void>;
  clear: () => Promise<void>;
}

export type MobileSessionResponseLike = {
  sessionId: string;
  deviceId: string;
  accessToken: string;
  accessTokenExpiresAtMs: number | string;
  refreshToken: string;
  refreshTokenExpiresAtMs: number | string;
};

export type MobileApiSessionOptions = {
  baseUrl: string;
  credentials: MobileCredentialStore;
  fetcher?: MobileFetcher;
  now?: () => number;
};

export type MobileRequestInit = {
  method?: string;
  headers?: Headers | Record<string, string> | readonly (readonly [string, string])[];
  body?: string;
};

export type MobileFetcher = (input: string, init?: MobileRequestInit) => Promise<Response>;

export type MobileRequestOptions = Omit<MobileRequestInit, "headers"> & {
  headers?: MobileRequestInit["headers"];
  retryOnUnauthorized?: boolean;
};

/**
 * A mobile authenticated HTTP session. Access is intentionally process-local;
 * the only durable credential boundary is the injected Keychain adapter.
 */
export class MobileApiSession {
  private baseUrl: string;
  private readonly credentials: MobileCredentialStore;
  private readonly fetcher: MobileFetcher;
  private readonly now: () => number;
  private accessToken: string | undefined;
  private refreshPromise: Promise<boolean> | undefined;

  public constructor(options: MobileApiSessionOptions) {
    this.baseUrl = normalizeMobileApiBaseUrl(options.baseUrl || "https://configure.invalid");
    this.credentials = options.credentials;
    this.fetcher = options.fetcher ?? ((input, init) => fetch(input, {
      method: init?.method,
      headers: headersFrom(init?.headers),
      body: init?.body
    }));
    this.now = options.now ?? Date.now;
  }

  public get accessTokenValue(): string | undefined {
    return this.accessToken;
  }

  public get apiBaseUrl(): string {
    return this.baseUrl;
  }

  public setBaseUrl(value: string): void {
    this.baseUrl = normalizeMobileApiBaseUrl(value);
  }

  public async initialize(): Promise<boolean> {
    const credential = await this.credentials.load();
    if (!credential) {
      this.accessToken = undefined;
      return false;
    }
    if (!isStoredCredential(credential) || credential.refreshTokenExpiresAtMs <= this.now()) {
      await this.clearCredentials();
      return false;
    }
    return this.refreshSingleFlight();
  }

  public async exchange(code: string, request: Record<string, unknown> = {}): Promise<MobileSessionResponseLike> {
    const normalizedCode = code.trim();
    if (!normalizedCode || normalizedCode.length > 200) {
      throw new Error("A valid mobile pairing code is required.");
    }

    const response = await this.fetchJson(
      "/api/v1/mobile-pairings/exchange",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...request, code: normalizedCode }),
        retryOnUnauthorized: false
      });
    if (!response.ok) {
      throw new MobileApiError(response.status, "Mobile pairing exchange failed.");
    }

    const session = await parseSessionResponse(response);
    await this.saveSession(session);
    return session;
  }

  public async refresh(): Promise<boolean> {
    return this.refreshSingleFlight();
  }

  public async request(path: string, options: MobileRequestOptions = {}): Promise<Response> {
    const retryOnUnauthorized = options.retryOnUnauthorized !== false;
    const first = await this.fetchJson(path, options);
    if (first.status !== 401 || !retryOnUnauthorized || path.endsWith("/mobile-sessions/refresh")) {
      if (first.status === 401) {
        this.accessToken = undefined;
      }
      return first;
    }

    if (!await this.refreshSingleFlight()) {
      return first;
    }

    const retry = await this.fetchJson(path, options);
    if (retry.status === 401) {
      this.accessToken = undefined;
    }
    return retry;
  }

  public async getJson<T>(path: string, options: MobileRequestOptions = {}): Promise<T> {
    const response = await this.request(path, { ...options, method: "GET" });
    return readJson<T>(response);
  }

  public async postJson<T>(
    path: string,
    body: unknown,
    idempotencyKey?: string,
    options: MobileRequestOptions = {}
  ): Promise<T> {
    const headers = headersFrom(options.headers);
    headers.set("Content-Type", "application/json");
    if (idempotencyKey) {
      headers.set("Idempotency-Key", idempotencyKey);
    }
    const response = await this.request(path, {
      ...options,
      method: "POST",
      headers,
      body: JSON.stringify(body)
    });
    return readJson<T>(response);
  }

  public async revoke(): Promise<void> {
    // A transport failure does not prove that the server revoked the session;
    // request() leaves both process-local access and durable refresh intact so
    // the user can retry revocation without unrelated re-authentication.
    const response = await this.request("/api/v1/mobile-sessions/revoke", {
      method: "POST",
      retryOnUnauthorized: false
    });
    if (!response.ok) {
      if (response.status === 401 || response.status === 404) {
        // The server already considers this session invalid. Treat logout as
        // terminal and clear the durable refresh credential locally.
        await this.clearCredentials();
        return;
      }
      throw new MobileApiError(response.status, "Mobile session revoke failed.");
    }
    await this.clearCredentials();
  }

  public async clearCredentials(): Promise<void> {
    this.accessToken = undefined;
    await this.credentials.clear();
  }

  private async refreshSingleFlight(): Promise<boolean> {
    if (this.refreshPromise) {
      return this.refreshPromise;
    }

    this.refreshPromise = this.refreshOnce().finally(() => {
      this.refreshPromise = undefined;
    });
    return this.refreshPromise;
  }

  private async refreshOnce(): Promise<boolean> {
    let credential: StoredMobileRefreshCredential | null;
    try {
      credential = await this.credentials.load();
    } catch {
      this.accessToken = undefined;
      return false;
    }
    if (!credential || !isStoredCredential(credential) || credential.refreshTokenExpiresAtMs <= this.now()) {
      await this.clearCredentials();
      return false;
    }

    let response: Response;
    try {
      response = await this.fetchJson("/api/v1/mobile-sessions/refresh", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sessionId: credential.sessionId,
          refreshToken: credential.refreshToken
        }),
        retryOnUnauthorized: false
      });
    } catch {
      this.accessToken = undefined;
      return false;
    }
    if (!response.ok) {
      this.accessToken = undefined;
      if (response.status === 401) {
        await this.clearCredentials();
      }
      return false;
    }

    try {
      const session = await parseSessionResponse(response);
      await this.saveSession(session);
      return true;
    } catch {
      this.accessToken = undefined;
      await this.clearCredentials();
      return false;
    }
  }

  private async saveSession(session: MobileSessionResponseLike): Promise<void> {
    const stored: StoredMobileRefreshCredential = {
      sessionId: session.sessionId,
      refreshToken: session.refreshToken,
      refreshTokenExpiresAtMs: numberValue(session.refreshTokenExpiresAtMs)
    };
    await this.credentials.save(stored);
    this.accessToken = session.accessToken;
  }

  private async fetchJson(path: string, options: MobileRequestOptions): Promise<Response> {
    const url = new URL(path, this.baseUrl).toString();
    const headers = headersFrom(options.headers);
    if (this.accessToken) {
      headers.set("Authorization", `Bearer ${this.accessToken}`);
    } else {
      headers.delete("Authorization");
    }
    const requestInit = { ...options };
    delete requestInit.retryOnUnauthorized;
    return this.fetcher(url, { ...requestInit, headers });
  }
}

/**
 * Mobile devices must use an HTTPS Control Plane URL. HTTP is accepted only
 * for loopback development (simulator/emulator); a physical phone cannot use
 * its own 127.0.0.1 address to reach a Desktop host.
 */
export function normalizeMobileApiBaseUrl(value: string): string {
  const normalized = value.trim();
  if (!normalized) {
    throw new Error("A mobile API base URL is required.");
  }

  let url: URL;
  try {
    url = new URL(normalized);
  } catch {
    throw new Error("The mobile API base URL must be an absolute URL.");
  }
  const loopback = url.hostname === "localhost"
    || url.hostname === "127.0.0.1"
    || url.hostname === "[::1]"
    || url.hostname === "::1";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
    throw new Error("The mobile API base URL must use HTTPS (loopback HTTP is for development only).");
  }
  if (url.username || url.password || url.hash) {
    throw new Error("The mobile API base URL must not contain credentials or a fragment.");
  }
  url.search = "";
  return url.toString().replace(/\/$/, "");
}

export class MobileApiError extends Error {
  public constructor(public readonly status: number, message: string) {
    super(message);
    this.name = "MobileApiError";
  }
}

async function parseSessionResponse(response: Response): Promise<MobileSessionResponseLike> {
  const value = await response.json() as unknown;
  if (!isRecord(value)
    || !isNonEmptyString(value.sessionId)
    || !isNonEmptyString(value.deviceId)
    || !isNonEmptyString(value.accessToken)
    || !value.accessToken.startsWith("jma_")
    || !isNonEmptyString(value.refreshToken)
    || !value.refreshToken.startsWith("jrefresh_")) {
    throw new Error("The mobile session response is invalid.");
  }
  const accessExpires = numberValue(value.accessTokenExpiresAtMs);
  const refreshExpires = numberValue(value.refreshTokenExpiresAtMs);
  if (accessExpires <= 0 || refreshExpires <= 0) {
    throw new Error("The mobile session expiry is invalid.");
  }
  return {
    sessionId: value.sessionId,
    deviceId: value.deviceId,
    accessToken: value.accessToken,
    accessTokenExpiresAtMs: accessExpires,
    refreshToken: value.refreshToken,
    refreshTokenExpiresAtMs: refreshExpires
  };
}

async function readJson<T>(response: Response): Promise<T> {
  if (!response.ok) {
    throw new MobileApiError(response.status, `Mobile API request failed with ${response.status}.`);
  }
  return response.json() as Promise<T>;
}

function isStoredCredential(value: StoredMobileRefreshCredential): boolean {
  return isNonEmptyString(value.sessionId)
    && isNonEmptyString(value.refreshToken)
    && value.refreshToken.startsWith("jrefresh_")
    && Number.isFinite(value.refreshTokenExpiresAtMs);
}

function numberValue(value: unknown): number {
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
  if (!Number.isFinite(parsed)) {
    throw new Error("Expected a finite number.");
  }
  return parsed;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= 500;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function headersFrom(value: MobileRequestInit["headers"]): Headers {
  const headers = new Headers();
  if (!value) {
    return headers;
  }
  if (value instanceof Headers) {
    value.forEach((headerValue, name) => headers.set(name, headerValue));
    return headers;
  }
  if (Array.isArray(value)) {
    for (const [name, headerValue] of value) {
      headers.set(name, headerValue);
    }
    return headers;
  }
  for (const [name, headerValue] of Object.entries(value)) {
    headers.set(name, headerValue);
  }
  return headers;
}
