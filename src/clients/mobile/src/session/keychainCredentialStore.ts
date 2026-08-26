import * as Keychain from "react-native-keychain";
import { normalizeMobileApiBaseUrl, type MobileCredentialStore, type StoredMobileRefreshCredential } from "./MobileApiSession";

const defaultService = "com.jarvis.mobile.refresh";
const endpointService = "com.jarvis.mobile.endpoint";

/** Production-only encrypted credential boundary for iOS Keychain/Android Keystore. */
export class KeychainMobileCredentialStore implements MobileCredentialStore {
  public constructor(private readonly service = defaultService) {}

  public async load(): Promise<StoredMobileRefreshCredential | null> {
    const result = await Keychain.getGenericPassword({ service: this.service });
    if (result === false) {
      return null;
    }
    try {
      const value = JSON.parse(result.password) as unknown;
      if (!isStoredCredential(value)) {
        await this.clear();
        return null;
      }
      return value;
    } catch {
      await this.clear();
      return null;
    }
  }

  public async save(value: StoredMobileRefreshCredential): Promise<void> {
    if (!isStoredCredential(value)) {
      throw new Error("The mobile refresh credential is invalid.");
    }
    await Keychain.setGenericPassword("jarvis-mobile", JSON.stringify(value), {
      service: this.service,
      accessible: Keychain.ACCESSIBLE.WHEN_UNLOCKED_THIS_DEVICE_ONLY
    });
  }

  public async clear(): Promise<void> {
    await Keychain.resetGenericPassword({ service: this.service });
  }
}

export interface MobileApiBaseUrlStore {
  load: () => Promise<string | null>;
  save: (value: string) => Promise<void>;
  clear: () => Promise<void>;
}

/** Persists only the user-selected Control Plane URL, never bearer credentials. */
export class KeychainMobileApiBaseUrlStore implements MobileApiBaseUrlStore {
  public constructor(private readonly service = endpointService) {}

  public async load(): Promise<string | null> {
    const result = await Keychain.getGenericPassword({ service: this.service });
    if (result === false) {
      return null;
    }
    try {
      return normalizeMobileApiBaseUrl(result.password);
    } catch {
      await this.clear();
      return null;
    }
  }

  public async save(value: string): Promise<void> {
    const normalized = normalizeMobileApiBaseUrl(value);
    await Keychain.setGenericPassword("jarvis-mobile-endpoint", normalized, {
      service: this.service,
      accessible: Keychain.ACCESSIBLE.WHEN_UNLOCKED_THIS_DEVICE_ONLY
    });
  }

  public async clear(): Promise<void> {
    await Keychain.resetGenericPassword({ service: this.service });
  }
}

function isStoredCredential(value: unknown): value is StoredMobileRefreshCredential {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const item = value as Record<string, unknown>;
  return typeof item.sessionId === "string"
    && item.sessionId.length > 0
    && typeof item.refreshToken === "string"
    && item.refreshToken.startsWith("jrefresh_")
    && typeof item.refreshTokenExpiresAtMs === "number"
    && Number.isFinite(item.refreshTokenExpiresAtMs);
}
