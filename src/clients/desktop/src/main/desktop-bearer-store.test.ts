import { strict as assert } from "node:assert";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  DesktopBearerStore,
  resolveDesktopBearer,
  type DesktopBearerCipher
} from "./desktop-bearer-store.js";

class FakeCipher implements DesktopBearerCipher {
  public constructor(private readonly available = true) {}

  public decryptString(encrypted: Buffer): string {
    const value = encrypted.toString("utf8");
    if (!value.startsWith("encrypted:")) {
      throw new Error("invalid ciphertext");
    }
    return value.slice("encrypted:".length);
  }

  public encryptString(plainText: string): Buffer {
    return Buffer.from(`encrypted:${plainText}`, "utf8");
  }

  public isEncryptionAvailable(): boolean {
    return this.available;
  }
}

function fixture(cipher: DesktopBearerCipher = new FakeCipher()) {
  const root = mkdtempSync(join(tmpdir(), "jarvis-desktop-bearer-"));
  const credentialPath = join(root, "credentials", "local-api-bearer.bin");
  return {
    cleanup: () => rmSync(root, { force: true, recursive: true }),
    credentialPath,
    root,
    store: new DesktopBearerStore(credentialPath, cipher)
  };
}

test("environment bearer is encrypted once and reused without an environment variable", () => {
  const testFixture = fixture();
  const token = "desktop-bearer-token-with-at-least-32-characters";
  try {
    const first = resolveDesktopBearer(token, testFixture.store);
    const second = resolveDesktopBearer(undefined, testFixture.store);

    assert.deepEqual(first, { source: "environment", token });
    assert.deepEqual(second, { source: "keychain", token });
    assert.notEqual(readFileSync(testFixture.credentialPath, "utf8"), token);
    assert.equal(statSync(join(testFixture.root, "credentials")).mode & 0o777, 0o700);
    assert.equal(statSync(testFixture.credentialPath).mode & 0o777, 0o600);
  } finally {
    testFixture.cleanup();
  }
});

test("a new environment bearer overrides and replaces the stored bearer", () => {
  const testFixture = fixture();
  const original = "original-desktop-bearer-with-at-least-32-characters";
  const replacement = "replacement-desktop-bearer-with-at-least-32-characters";
  try {
    resolveDesktopBearer(original, testFixture.store);
    resolveDesktopBearer(replacement, testFixture.store);

    assert.deepEqual(resolveDesktopBearer(undefined, testFixture.store), {
      source: "keychain",
      token: replacement
    });
  } finally {
    testFixture.cleanup();
  }
});

test("an invalid environment override fails closed instead of using an older stored bearer", () => {
  const testFixture = fixture();
  try {
    resolveDesktopBearer(
      "stored-desktop-bearer-with-at-least-32-characters",
      testFixture.store);

    assert.throws(
      () => resolveDesktopBearer("too-short", testFixture.store),
      /JARVIS_LOCAL_BEARER must contain at least 32 characters/);
  } finally {
    testFixture.cleanup();
  }
});

test("an environment bearer remains usable when Keychain encryption is unavailable", () => {
  const testFixture = fixture(new FakeCipher(false));
  const token = "temporary-desktop-bearer-with-at-least-32-characters";
  try {
    const resolution = resolveDesktopBearer(token, testFixture.store);

    assert.equal(resolution.source, "environment");
    assert.equal(resolution.token, token);
    assert.match(resolution.persistenceError?.message ?? "", /Keychain encryption is unavailable/);
    assert.deepEqual(resolveDesktopBearer(undefined, testFixture.store), { source: "missing" });
  } finally {
    testFixture.cleanup();
  }
});

test("corrupted encrypted storage fails closed", () => {
  const testFixture = fixture();
  try {
    resolveDesktopBearer(
      "stored-desktop-bearer-with-at-least-32-characters",
      testFixture.store);
    writeFileSync(testFixture.credentialPath, "not-encrypted", { mode: 0o600 });

    assert.throws(
      () => resolveDesktopBearer(undefined, testFixture.store),
      /could not be decrypted or is invalid/);
  } finally {
    testFixture.cleanup();
  }
});
