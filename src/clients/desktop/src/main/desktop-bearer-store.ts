import { randomUUID } from "node:crypto";
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { dirname } from "node:path";

export const desktopBearerEnvironmentVariable = "JARVIS_LOCAL_BEARER";
export const minimumDesktopBearerLength = 32;

const desktopBearerCredentialVersion = 1;
const maximumDesktopBearerCredentialBytes = 16 * 1024;
const ownerOnlyCredentialDirectoryMode = 0o700;
const ownerOnlyCredentialFileMode = 0o600;

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
  const message = reason instanceof Error ? reason.message : "";
  if (message.includes("Keychain encryption is unavailable")
    || message.includes("owner-only credential")
    || message.startsWith("The Desktop backend bearer could not be persisted securely")) {
    return new Error(message);
  }
  return new Error("The Desktop backend bearer could not be persisted securely.");
}

function requireValidBearer(token: unknown, source: string): string {
  if (typeof token !== "string" || token.length < minimumDesktopBearerLength) {
    throw new Error(`${source} must contain at least ${minimumDesktopBearerLength} characters.`);
  }
  if (token !== token.trim() || /\s/.test(token)) {
    throw new Error(`${source} must not contain whitespace.`);
  }
  return token;
}

function invalidStoredCredential(): Error {
  return new Error("The stored Desktop backend bearer could not be decrypted or is invalid; bootstrap it again.");
}

function credentialDirectoryError(): Error {
  return new Error("The Desktop backend credential directory must be an owner-only credential directory.");
}

function credentialFileError(): Error {
  return new Error("The Desktop backend credential file must be a regular owner-only credential file.");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function tryDecodeStoredEnvelope(encrypted: Buffer): Buffer | undefined {
  if (encrypted.length === 0 || encrypted.length > maximumDesktopBearerCredentialBytes) {
    return undefined;
  }

  let envelope: unknown;
  try {
    envelope = JSON.parse(encrypted.toString("utf8"));
  } catch {
    return undefined;
  }

  if (!isRecord(envelope)
    || Object.keys(envelope).sort().join(",") !== "ciphertext,version"
    || envelope.version !== desktopBearerCredentialVersion
    || typeof envelope.ciphertext !== "string"
    || envelope.ciphertext.length === 0
    || envelope.ciphertext.length > maximumDesktopBearerCredentialBytes
    || envelope.ciphertext.length % 4 !== 0
    || !/^[A-Za-z0-9+/]+={0,2}$/.test(envelope.ciphertext)) {
    return undefined;
  }

  const ciphertext = Buffer.from(envelope.ciphertext, "base64");
  if (ciphertext.length === 0) {
    return undefined;
  }
  return ciphertext;
}

function decryptStoredBearer(encrypted: Buffer, cipher: DesktopBearerCipher): string {
  if (encrypted.length === 0 || encrypted.length > maximumDesktopBearerCredentialBytes) {
    throw invalidStoredCredential();
  }
  const envelopeCiphertext = tryDecodeStoredEnvelope(encrypted);
  const candidates = envelopeCiphertext === undefined
    ? [encrypted]
    : [envelopeCiphertext, encrypted];
  for (const candidate of candidates) {
    try {
      return requireValidBearer(
        cipher.decryptString(candidate),
        "The stored Desktop backend bearer");
    } catch {
      // A valid envelope may be an opaque legacy ciphertext that happens to parse as JSON.
    }
  }
  throw invalidStoredCredential();
}

export class DesktopBearerStore {
  public constructor(
    private readonly credentialPath: string,
    private readonly cipher: DesktopBearerCipher
  ) {}

  public read(): string | undefined {
    if (!this.ensureCredentialDirectory(false)) {
      return undefined;
    }

    let encrypted: Buffer;
    try {
      const file = lstatSync(this.credentialPath);
      if (!file.isFile() || (file.mode & 0o777) !== ownerOnlyCredentialFileMode) {
        throw credentialFileError();
      }
      encrypted = readFileSync(this.credentialPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return undefined;
      }
      if (error instanceof Error && error.message === credentialFileError().message) {
        throw error;
      }
      throw new Error("The stored Desktop backend bearer could not be read securely; bootstrap it again.");
    }

    let encryptionAvailable: boolean;
    try {
      encryptionAvailable = this.cipher.isEncryptionAvailable();
    } catch {
      throw new Error("macOS Keychain encryption is unavailable for the stored Desktop backend bearer.");
    }
    if (!encryptionAvailable) {
      throw new Error("macOS Keychain encryption is unavailable for the stored Desktop backend bearer.");
    }

    try {
      return decryptStoredBearer(encrypted, this.cipher);
    } catch {
      throw invalidStoredCredential();
    }
  }

  public write(token: string): void {
    const validToken = requireValidBearer(token, desktopBearerEnvironmentVariable);
    let encryptionAvailable: boolean;
    try {
      encryptionAvailable = this.cipher.isEncryptionAvailable();
    } catch {
      throw new Error("macOS Keychain encryption is unavailable; the Desktop backend bearer was not persisted.");
    }
    if (!encryptionAvailable) {
      throw new Error("macOS Keychain encryption is unavailable; the Desktop backend bearer was not persisted.");
    }

    this.ensureCredentialDirectory(true);
    try {
      const existingFile = lstatSync(this.credentialPath);
      if (!existingFile.isFile() || (existingFile.mode & 0o777) !== ownerOnlyCredentialFileMode) {
        throw credentialFileError();
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        if (error instanceof Error && error.message === credentialFileError().message) {
          throw error;
        }
        throw credentialFileError();
      }
    }

    const temporaryPath = `${this.credentialPath}.${process.pid}.${randomUUID()}.tmp`;
    try {
      const encrypted = this.cipher.encryptString(validToken);
      if (!Buffer.isBuffer(encrypted)
        || encrypted.length === 0
        || encrypted.length > maximumDesktopBearerCredentialBytes) {
        throw new Error("Invalid safeStorage ciphertext.");
      }
      const envelope = JSON.stringify({
        ciphertext: encrypted.toString("base64"),
        version: desktopBearerCredentialVersion
      });
      writeFileSync(temporaryPath, `${envelope}\n`, {
        flag: "wx",
        mode: ownerOnlyCredentialFileMode
      });
      chmodSync(temporaryPath, ownerOnlyCredentialFileMode);
      renameSync(temporaryPath, this.credentialPath);
      chmodSync(this.credentialPath, ownerOnlyCredentialFileMode);
    } catch {
      rmSync(temporaryPath, { force: true });
      throw new Error("The Desktop backend bearer could not be persisted securely; no plaintext was written.");
    }
  }

  private ensureCredentialDirectory(create: boolean): boolean {
    const credentialDirectory = dirname(this.credentialPath);
    try {
      const directory = lstatSync(credentialDirectory);
      if (!directory.isDirectory() || (directory.mode & 0o777) !== ownerOnlyCredentialDirectoryMode) {
        throw credentialDirectoryError();
      }
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        if (error instanceof Error && error.message === credentialDirectoryError().message) {
          throw error;
        }
        throw credentialDirectoryError();
      }
      if (!create) {
        return false;
      }
    }

    try {
      mkdirSync(credentialDirectory, {
        recursive: true,
        mode: ownerOnlyCredentialDirectoryMode
      });
    } catch {
      throw credentialDirectoryError();
    }

    let directory;
    try {
      directory = lstatSync(credentialDirectory);
    } catch {
      throw credentialDirectoryError();
    }
    if (!directory.isDirectory() || (directory.mode & 0o777) !== ownerOnlyCredentialDirectoryMode) {
      throw credentialDirectoryError();
    }
    return true;
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
