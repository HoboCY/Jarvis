import { randomUUID } from "node:crypto";
import {
  chmodSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { dirname } from "node:path";

export const desktopBearerEnvironmentVariable = "JARVIS_LOCAL_BEARER";
export const minimumDesktopBearerLength = 32;

export type DesktopBearerCipher = {
  decryptString: (encrypted: Buffer) => string;
  encryptString: (plainText: string) => Buffer;
  isEncryptionAvailable: () => boolean;
};

export type DesktopBearerResolution = {
  persistenceError?: Error;
  source: "environment" | "keychain" | "missing";
  token?: string;
};

function asError(reason: unknown): Error {
  return reason instanceof Error ? reason : new Error(String(reason));
}

function requireValidBearer(token: string, source: string): string {
  if (token.length < minimumDesktopBearerLength) {
    throw new Error(`${source} must contain at least ${minimumDesktopBearerLength} characters.`);
  }
  return token;
}

export class DesktopBearerStore {
  public constructor(
    private readonly credentialPath: string,
    private readonly cipher: DesktopBearerCipher
  ) {}

  public read(): string | undefined {
    let encrypted: Buffer;
    try {
      encrypted = readFileSync(this.credentialPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return undefined;
      }
      throw new Error("The stored Desktop backend bearer could not be read.", { cause: error });
    }

    if (!this.cipher.isEncryptionAvailable()) {
      throw new Error("macOS Keychain encryption is unavailable for the stored Desktop backend bearer.");
    }

    try {
      return requireValidBearer(
        this.cipher.decryptString(encrypted),
        "The stored Desktop backend bearer");
    } catch (error) {
      throw new Error("The stored Desktop backend bearer could not be decrypted or is invalid.", { cause: error });
    }
  }

  public write(token: string): void {
    const validToken = requireValidBearer(token, desktopBearerEnvironmentVariable);
    if (!this.cipher.isEncryptionAvailable()) {
      throw new Error("macOS Keychain encryption is unavailable; the Desktop backend bearer was not persisted.");
    }

    const credentialDirectory = dirname(this.credentialPath);
    mkdirSync(credentialDirectory, { recursive: true, mode: 0o700 });
    chmodSync(credentialDirectory, 0o700);
    const temporaryPath = `${this.credentialPath}.${process.pid}.${randomUUID()}.tmp`;
    try {
      writeFileSync(temporaryPath, this.cipher.encryptString(validToken), {
        flag: "wx",
        mode: 0o600
      });
      chmodSync(temporaryPath, 0o600);
      renameSync(temporaryPath, this.credentialPath);
      chmodSync(this.credentialPath, 0o600);
    } catch (error) {
      rmSync(temporaryPath, { force: true });
      throw new Error("The Desktop backend bearer could not be persisted securely.", { cause: error });
    }
  }
}

export function resolveDesktopBearer(
  environmentToken: string | undefined,
  store: DesktopBearerStore
): DesktopBearerResolution {
  if (environmentToken !== undefined) {
    const token = requireValidBearer(environmentToken, desktopBearerEnvironmentVariable);
    try {
      store.write(token);
      return { source: "environment", token };
    } catch (error) {
      return {
        persistenceError: asError(error),
        source: "environment",
        token
      };
    }
  }

  const token = store.read();
  return token
    ? { source: "keychain", token }
    : { source: "missing" };
}
