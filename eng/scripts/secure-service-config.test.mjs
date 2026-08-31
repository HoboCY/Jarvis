import { execFile } from "node:child_process";
import { strict as assert } from "node:assert";
import { chmod, lstat, mkdir, mkdtemp, readFile, realpath, rm, stat, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import {
  writeApiConfiguration,
  writeDeviceRuntimeConfiguration,
  validateIndependentCodexHomePath
} from "./secure-service-config.mjs";

const execFileAsync = promisify(execFile);

test("service configuration is written with owner-only permissions and no plist secret", async () => {
  const root = await mkdtemp(join(tmpdir(), "jarvis-secure-config-"));
  try {
    const physicalRoot = await realpath(root);
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
    const configuration = JSON.parse(contents);
    assert.deepEqual(configuration.Responses, {
      Provider: "OpenAI",
      Model: "gpt-4.1-mini",
      SummarizerModel: "gpt-4.1-mini",
      TimeoutSeconds: 5,
      MaxTransientRetries: 0,
      PollingIntervalMs: 100
    });
    assert.equal(configuration.OpenAI.ResponsesModel, undefined);
    assert.equal(configuration.OpenAI.SummarizerModel, undefined);

    const codexHome = join(physicalRoot, "codex-home");
    const runtimePath = await writeDeviceRuntimeConfiguration({
      directory: root,
      apiBaseUrl: "http://127.0.0.1:5000",
      deviceId: "00000000-0000-7000-8000-000000000001",
      codexHome,
      credentialFilePath: join(root, "device-identity.json"),
    });
    assert.equal((await stat(runtimePath)).mode & 0o777, 0o600);
    const runtimeContents = await readFile(runtimePath, "utf8");
    assert.match(runtimeContents, /CredentialFilePath/);
    assert.equal(runtimeContents.includes("DeviceCredential"), false);
    assert.equal(JSON.parse(runtimeContents).DeviceNode.CodexHome, codexHome);
    assert.equal((await stat(codexHome)).mode & 0o777, 0o700);

    const keychainCodexHome = join(physicalRoot, "keychain-codex-home");
    const keychainRuntimePath = await writeDeviceRuntimeConfiguration({
      directory: root,
      apiBaseUrl: "http://127.0.0.1:5000",
      deviceId: "00000000-0000-7000-8000-000000000001",
      codexHome: keychainCodexHome,
      keychainService: "com.hobocy.jarvis.phase6.test.runtime",
      keychainAccount: "jarvis-phase6-runtime"
    });
    assert.equal((await stat(keychainRuntimePath)).mode & 0o777, 0o600);
    assert.equal((await readFile(keychainRuntimePath, "utf8")).includes("DeviceCredential"), false);
    assert.equal((await stat(keychainCodexHome)).mode & 0o777, 0o700);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("secure service configuration writes DeepSeek credentials only when selected", async () => {
  const root = await mkdtemp(join(tmpdir(), "jarvis-secure-config-deepseek-"));
  try {
    const apiPath = await writeApiConfiguration({
      directory: root,
      bearerToken: "t".repeat(64),
      openAiApiKey: "phase6-realtime-key",
      openAiBaseUrl: "https://api.openai.com/",
      databasePath: join(root, "jarvis.db"),
      responsesProvider: "DeepSeek",
      deepSeekApiKey: "phase6-deepseek-key",
      deepSeekBaseUrl: "https://api.deepseek.com/"
    });
    const configuration = JSON.parse(await readFile(apiPath, "utf8"));
    assert.deepEqual(configuration.Responses, {
      Provider: "DeepSeek",
      Model: "deepseek-v4-flash",
      SummarizerModel: "deepseek-v4-flash",
      TimeoutSeconds: 5,
      MaxTransientRetries: 0,
      PollingIntervalMs: 100
    });
    assert.deepEqual(configuration.DeepSeek, {
      ApiKey: "phase6-deepseek-key",
      BaseUrl: "https://api.deepseek.com/"
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("secure service configuration rejects missing selected DeepSeek credentials", async () => {
  const root = await mkdtemp(join(tmpdir(), "jarvis-secure-config-deepseek-invalid-"));
  try {
    await assert.rejects(() => writeApiConfiguration({
      directory: root,
      bearerToken: "t".repeat(64),
      openAiApiKey: "phase6-realtime-key",
      openAiBaseUrl: "https://api.openai.com/",
      databasePath: join(root, "jarvis.db"),
      responsesProvider: "DeepSeek",
      deepSeekBaseUrl: "https://api.deepseek.com/"
    }), /deepSeekApiKey/i);
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

test("device runtime configuration requires an independent Codex home", async () => {
  const root = await mkdtemp(join(tmpdir(), "jarvis-secure-config-codex-home-"));
  try {
    await assert.rejects(() => writeDeviceRuntimeConfiguration({
      directory: root,
      apiBaseUrl: "http://127.0.0.1:5000",
      deviceId: "00000000-0000-7000-8000-000000000001",
      credentialFilePath: join(root, "device-identity.json")
    }), /codexHome/i);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("device runtime configuration rejects an existing ancestor symlink before changing its mode", async () => {
  if (process.platform === "win32") return;

  const root = await mkdtemp(join(tmpdir(), "jarvis-secure-config-ancestor-link-"));
  try {
    const physicalRoot = await realpath(root);
    const physicalParent = join(physicalRoot, "physical-parent");
    const realCodexHome = join(physicalParent, "codex-home");
    await mkdir(realCodexHome, { recursive: true, mode: 0o740 });
    await chmod(realCodexHome, 0o740);
    const linkedParent = join(physicalRoot, "linked-parent");
    await symlink(physicalParent, linkedParent, "dir");

    await assert.rejects(() => writeDeviceRuntimeConfiguration({
      directory: root,
      apiBaseUrl: "http://127.0.0.1:5000",
      deviceId: "00000000-0000-7000-8000-000000000001",
      codexHome: join(linkedParent, "codex-home"),
      credentialFilePath: join(root, "device-identity.json")
    }), /codexHome/i);
    assert.equal((await stat(realCodexHome)).mode & 0o777, 0o740);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("device runtime configuration rejects a macOS case alias of the user's Codex home without changing its mode", async () => {
  if (process.platform !== "darwin") return;

  const root = await mkdtemp(join(tmpdir(), "jarvis-secure-config-case-alias-"));
  try {
    const physicalRoot = await realpath(root);
    const userHome = join(physicalRoot, "simulated-user-home");
    const realCodexHome = join(userHome, ".codex");
    await mkdir(realCodexHome, { recursive: true, mode: 0o740 });
    await chmod(realCodexHome, 0o740);
    const casingAlias = join(userHome, ".CODEX");
    try {
      await lstat(casingAlias);
    } catch {
      return;
    }

    await assert.rejects(
      () => validateIndependentCodexHomePath(casingAlias, userHome),
      /codexHome/i);
    assert.equal((await stat(realCodexHome)).mode & 0o777, 0o740);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Codex home validation uses the OS userInfo home despite a fake HOME", async () => {
  const root = await mkdtemp(join(tmpdir(), "jarvis-secure-config-no-home-override-"));
  try {
    const fakeHome = join(await realpath(root), "fake-home");
    await mkdir(fakeHome, { recursive: true });
    const moduleUrl = new URL("./secure-service-config.mjs", import.meta.url).href;
    const childScript = `
      import { userInfo } from "node:os";
      import { join } from "node:path";
      import { validateIndependentCodexHomePath } from ${JSON.stringify(moduleUrl)};

      const codexHome = join(userInfo().homedir, ".codex");
      try {
        await validateIndependentCodexHomePath(codexHome);
        console.error("real user Codex home was accepted");
        process.exitCode = 1;
      } catch (error) {
        if (!/codexHome/i.test(error?.message ?? "")) {
          console.error(error);
          process.exitCode = 2;
        }
      }
    `;

    await execFileAsync(process.execPath, ["--input-type=module", "-e", childScript], {
      env: { ...process.env, HOME: fakeHome }
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
