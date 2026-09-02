import { strict as assert } from "node:assert";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync
} from "node:fs";
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

class UnavailablePersistenceCipher extends FakeCipher {
  public override encryptString(): Buffer {
    throw new Error("safeStorage unavailable for bearer");
  }
}

class SecretLeakingDecryptCipher extends FakeCipher {
  public constructor(private readonly message: string) {
    super();
  }

  public override decryptString(): string {
    throw new Error(this.message);
  }
}

class UnexpectedDecryptedCredentialCipher extends FakeCipher {
  public override decryptString(): string {
    return { bearer: "unexpected-shape" } as unknown as string;
  }
}

class LeadingBraceLegacyCipher implements DesktopBearerCipher {
  public constructor(private readonly expectedCiphertext: Buffer) {}

  public decryptString(encrypted: Buffer): string {
    if (!encrypted.equals(this.expectedCiphertext)) {
      throw new Error("only the opaque legacy ciphertext can be decrypted");
    }
    return "legacy-desktop-bearer-with-at-least-32-characters";
  }

  public encryptString(): Buffer {
    return this.expectedCiphertext;
  }

  public isEncryptionAvailable(): boolean {
    return true;
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

test("a malformed environment override with whitespace fails closed", () => {
  const testFixture = fixture();
  const original = "original-desktop-bearer-with-at-least-32-characters";
  try {
    resolveDesktopBearer(original, testFixture.store);

    assert.throws(
      () => resolveDesktopBearer(` ${original}`, testFixture.store),
      /JARVIS_LOCAL_BEARER must not contain whitespace/);
    assert.deepEqual(resolveDesktopBearer(undefined, testFixture.store), {
      source: "keychain",
      token: original
    });
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

test("stored credentials use a versioned encrypted envelope", () => {
  const testFixture = fixture();
  try {
    resolveDesktopBearer(
      "stored-desktop-bearer-with-at-least-32-characters",
      testFixture.store);
    const stored = JSON.parse(readFileSync(testFixture.credentialPath, "utf8")) as Record<string, unknown>;

    assert.deepEqual(Object.keys(stored).sort(), ["ciphertext", "version"]);
    assert.equal(stored.version, 1);
    assert.equal(typeof stored.ciphertext, "string");
    assert.doesNotMatch(JSON.stringify(stored), /stored-desktop-bearer/);
  } finally {
    testFixture.cleanup();
  }
});

test("legacy raw safeStorage ciphertext remains readable after restart", () => {
  const testFixture = fixture();
  const token = "legacy-desktop-bearer-with-at-least-32-characters";
  try {
    mkdirSync(join(testFixture.root, "credentials"), { mode: 0o700 });
    writeFileSync(
      testFixture.credentialPath,
      new FakeCipher().encryptString(token),
      { mode: 0o600 });

    assert.deepEqual(resolveDesktopBearer(undefined, testFixture.store), {
      source: "keychain",
      token
    });
  } finally {
    testFixture.cleanup();
  }
});

test("opaque legacy ciphertext is readable even when it starts with a JSON-looking byte", () => {
  const token = "legacy-desktop-bearer-with-at-least-32-characters";
  const legacyCiphertext = Buffer.from(`{opaque-safeStorage:${token}`, "utf8");
  const testFixture = fixture(new LeadingBraceLegacyCipher(legacyCiphertext));
  try {
    mkdirSync(join(testFixture.root, "credentials"), { mode: 0o700 });
    writeFileSync(testFixture.credentialPath, legacyCiphertext, { mode: 0o600 });

    assert.deepEqual(resolveDesktopBearer(undefined, testFixture.store), {
      source: "keychain",
      token
    });
  } finally {
    testFixture.cleanup();
  }
});

test("legacy ciphertext remains readable when it happens to be a complete envelope candidate", () => {
  const legacyCiphertext = Buffer.from(JSON.stringify({
    ciphertext: Buffer.from("opaque-legacy-payload", "utf8").toString("base64"),
    version: 1
  }), "utf8");
  const testFixture = fixture(new LeadingBraceLegacyCipher(legacyCiphertext));
  try {
    mkdirSync(join(testFixture.root, "credentials"), { mode: 0o700 });
    writeFileSync(testFixture.credentialPath, legacyCiphertext, { mode: 0o600 });

    assert.deepEqual(resolveDesktopBearer(undefined, testFixture.store), {
      source: "keychain",
      token: "legacy-desktop-bearer-with-at-least-32-characters"
    });
  } finally {
    testFixture.cleanup();
  }
});

test("JSON-looking legacy content is not accepted as raw ciphertext", () => {
  const testFixture = fixture();
  try {
    mkdirSync(join(testFixture.root, "credentials"), { mode: 0o700 });
    writeFileSync(
      testFixture.credentialPath,
      '{"ciphertext":"encrypted:legacy-looking-content"}',
      { mode: 0o600 });

    assert.throws(
      () => testFixture.store.read(),
      /could not be decrypted or is invalid/);
  } finally {
    testFixture.cleanup();
  }
});

test("unexpected credential shape fails with a bounded error", () => {
  const testFixture = fixture();
  const secret = "unexpected-shape-secret-that-must-not-escape";
  try {
    mkdirSync(join(testFixture.root, "credentials"), { mode: 0o700 });
    writeFileSync(
      testFixture.credentialPath,
      JSON.stringify({ version: 99, ciphertext: secret, extra: "unexpected" }),
      { mode: 0o600 });

    assert.throws(
      () => testFixture.store.read(),
      error => {
        assert.match((error as Error).message, /credential format|decrypted or is invalid/);
        assert.doesNotMatch((error as Error).message, new RegExp(secret));
        assert.doesNotMatch((error as Error).message, new RegExp(testFixture.root));
        return true;
      });
  } finally {
    testFixture.cleanup();
  }
});

test("unsafe credential directory permissions fail closed", () => {
  const testFixture = fixture();
  try {
    resolveDesktopBearer(
      "stored-desktop-bearer-with-at-least-32-characters",
      testFixture.store);
    const credentialDirectory = join(testFixture.root, "credentials");
    chmodSync(credentialDirectory, 0o750);

    assert.throws(
      () => testFixture.store.read(),
      /owner-only credential directory/);
    const resolution = resolveDesktopBearer(
      "replacement-desktop-bearer-with-at-least-32-characters",
      testFixture.store);
    assert.equal(resolution.source, "environment");
    assert.equal(resolution.token, "replacement-desktop-bearer-with-at-least-32-characters");
    assert.match(resolution.persistenceError?.message ?? "", /owner-only credential directory/);
  } finally {
    testFixture.cleanup();
  }
});

test("unsafe credential file permissions fail closed", () => {
  const testFixture = fixture();
  try {
    resolveDesktopBearer(
      "stored-desktop-bearer-with-at-least-32-characters",
      testFixture.store);
    chmodSync(testFixture.credentialPath, 0o640);

    assert.throws(
      () => testFixture.store.read(),
      /owner-only credential file/);
  } finally {
    testFixture.cleanup();
  }
});

test("credential symlinks fail closed instead of being followed", () => {
  const testFixture = fixture();
  const targetPath = join(testFixture.root, "outside-credential.bin");
  try {
    resolveDesktopBearer(
      "stored-desktop-bearer-with-at-least-32-characters",
      testFixture.store);
    writeFileSync(targetPath, readFileSync(testFixture.credentialPath), { mode: 0o600 });
    rmSync(testFixture.credentialPath);
    symlinkSync(targetPath, testFixture.credentialPath);

    assert.throws(
      () => testFixture.store.read(),
      /owner-only credential file/);
  } finally {
    testFixture.cleanup();
  }
});

test("non-regular credential entries fail closed", () => {
  const testFixture = fixture();
  try {
    resolveDesktopBearer(
      "stored-desktop-bearer-with-at-least-32-characters",
      testFixture.store);
    rmSync(testFixture.credentialPath);
    mkdirSync(testFixture.credentialPath, { mode: 0o700 });

    assert.throws(
      () => testFixture.store.read(),
      /owner-only credential file/);
  } finally {
    testFixture.cleanup();
  }
});

test("credential directory symlinks fail closed instead of being followed", () => {
  const testFixture = fixture();
  const targetDirectory = join(testFixture.root, "outside-credentials");
  try {
    mkdirSync(targetDirectory, { mode: 0o700 });
    writeFileSync(
      join(targetDirectory, "local-api-bearer.bin"),
      JSON.stringify({ version: 1, ciphertext: Buffer.from("encrypted:secret").toString("base64") }),
      { mode: 0o600 });
    symlinkSync(targetDirectory, join(testFixture.root, "credentials"));

    assert.throws(
      () => testFixture.store.read(),
      /owner-only credential directory/);
  } finally {
    testFixture.cleanup();
  }
});

test("persistence failures clean up temporary ciphertext files", () => {
  const testFixture = fixture(new UnavailablePersistenceCipher());
  const token = "temporary-desktop-bearer-with-at-least-32-characters";
  try {
    assert.throws(() => testFixture.store.write(token), /could not be persisted securely/);
    assert.deepEqual(readdirSync(join(testFixture.root, "credentials")), []);
  } finally {
    testFixture.cleanup();
  }
});

test("storage errors never expose bearer, path, or provider details", () => {
  const secret = "Bearer provider-secret-that-must-not-escape";
  const testFixture = fixture(new SecretLeakingDecryptCipher(`${secret} at ${join(tmpdir(), "private-path")}`));
  try {
    const writer = new DesktopBearerStore(testFixture.credentialPath, new FakeCipher());
    writer.write("stored-desktop-bearer-with-at-least-32-characters");

    assert.throws(
      () => testFixture.store.read(),
      error => {
        assert.equal(
          (error as Error).message,
          "The stored Desktop backend bearer could not be decrypted or is invalid; bootstrap it again.");
        assert.equal("cause" in (error as Error), false);
        assert.doesNotMatch((error as Error).message, /provider-secret|private-path/);
        return true;
      });
  } finally {
    testFixture.cleanup();
  }
});

test("unexpected decrypted credential shape fails closed", () => {
  const testFixture = fixture(new UnexpectedDecryptedCredentialCipher());
  try {
    const writer = new DesktopBearerStore(testFixture.credentialPath, new FakeCipher());
    writer.write("stored-desktop-bearer-with-at-least-32-characters");

    assert.throws(
      () => testFixture.store.read(),
      /could not be decrypted or is invalid/);
  } finally {
    testFixture.cleanup();
  }
});
