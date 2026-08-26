import { strict as assert } from "node:assert";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  writeApiConfiguration,
  writeDeviceRuntimeConfiguration
} from "./secure-service-config.mjs";

test("service configuration is written with owner-only permissions and no plist secret", async () => {
  const root = await mkdtemp(join(tmpdir(), "jarvis-secure-config-"));
  try {
    const apiPath = await writeApiConfiguration({
      directory: root,
      bearerToken: "t".repeat(64),
      openAiApiKey: "phase6-fake-provider-key",
      openAiBaseUrl: "http://127.0.0.1:65535/",
      databasePath: join(root, "jarvis.db")
    });
    const metadata = await stat(apiPath);
    assert.equal(metadata.mode & 0o777, 0o600);
    const contents = await readFile(apiPath, "utf8");
    assert.match(contents, /Authentication/);
    assert.match(contents, /ConnectionStrings/);
    assert.equal(contents.includes("JARVIS_LOCAL_BEARER"), false);
    assert.equal(contents.includes("/usr/bin/security"), false);

    const runtimePath = await writeDeviceRuntimeConfiguration({
      directory: root,
      apiBaseUrl: "http://127.0.0.1:5000",
      deviceId: "00000000-0000-7000-8000-000000000001",
      credentialFilePath: join(root, "device-identity.json"),
    });
    assert.equal((await stat(runtimePath)).mode & 0o777, 0o600);
    assert.match((await readFile(runtimePath, "utf8")), /CredentialFilePath/);
    assert.equal((await readFile(runtimePath, "utf8")).includes("DeviceCredential"), false);

    const keychainRuntimePath = await writeDeviceRuntimeConfiguration({
      directory: root,
      apiBaseUrl: "http://127.0.0.1:5000",
      deviceId: "00000000-0000-7000-8000-000000000001",
      keychainService: "com.hobocy.jarvis.phase6.test.runtime",
      keychainAccount: "jarvis-phase6-runtime"
    });
    assert.equal((await stat(keychainRuntimePath)).mode & 0o777, 0o600);
    assert.equal((await readFile(keychainRuntimePath, "utf8")).includes("DeviceCredential"), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("secure service configuration rejects missing required credentials", async () => {
  const root = await mkdtemp(join(tmpdir(), "jarvis-secure-config-invalid-"));
  try {
    await assert.rejects(() => writeApiConfiguration({
      directory: root,
      bearerToken: "short",
      openAiApiKey: "key",
      openAiBaseUrl: "http://127.0.0.1:1/",
      databasePath: join(root, "jarvis.db")
    }), /bearer/i);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
