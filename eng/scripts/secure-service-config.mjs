import { mkdir, chmod, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export async function writeApiConfiguration({
  directory,
  bearerToken,
  openAiApiKey,
  openAiBaseUrl,
  databasePath,
  fakeWorkerEnabled = false,
  fakeWorkerDelayMs = 50
}) {
  assertDirectory(directory);
  assertSecret(bearerToken, "bearerToken", 32);
  assertSecret(openAiApiKey, "openAiApiKey", 1);
  assertUrl(openAiBaseUrl, "openAiBaseUrl");
  assertPath(databasePath, "databasePath");
  return writeSecureJsonFile(join(resolve(directory), "appsettings.Production.json"), {
    Authentication: { BearerToken: bearerToken },
    ConnectionStrings: { Jarvis: `Data Source=${databasePath}` },
    OpenAI: {
      ApiKey: openAiApiKey,
      BaseUrl: openAiBaseUrl,
      RealtimeModel: "gpt-4o-realtime-preview",
      RealtimeVoice: "alloy",
      AllowedVoices: ["alloy"],
      SafetyIdentifierSalt: "phase6-local-smoke-salt",
      ResponsesModel: "gpt-4.1-mini",
      SummarizerModel: "gpt-4.1-mini",
      ClientSecretLifetimeSeconds: 600,
      ResponsesTimeoutSeconds: 5,
      ResponsesMaxTransientRetries: 0,
      ResponsesPollingIntervalMs: 100
    },
    Outbox: { Enabled: false },
    FakeWorker: { Enabled: fakeWorkerEnabled, DelayMs: fakeWorkerDelayMs },
    ResponsesWorker: { Enabled: false },
    SummaryWorker: { Enabled: false },
    Diagnostics: { RequireLoopback: true, Enabled: true }
  });
}

/**
 * Writes the steady-state Device Node configuration after pairing.
 *
 * The credential is deliberately absent from this file. DeviceNodeBootstrapper
 * loads it from either the configured macOS Keychain service/account or the
 * explicit owner-only credential file seam used by isolated smoke tests.
 */
export async function writeDeviceRuntimeConfiguration({
  directory,
  apiBaseUrl,
  deviceId,
  credentialFilePath,
  keychainService,
  keychainAccount
}) {
  assertDirectory(directory);
  assertUrl(apiBaseUrl, "apiBaseUrl");
  assertUuid(deviceId, "deviceId");
  if (credentialFilePath !== undefined) {
    assertPath(credentialFilePath, "credentialFilePath");
  } else {
    assertSafeText(keychainService, "keychainService");
    assertSafeText(keychainAccount, "keychainAccount");
  }
  const deviceNode = {
    ApiBaseUrl: apiBaseUrl,
    DeviceId: "00000000-0000-0000-0000-000000000000",
    PollingIntervalMs: 100,
    HeartbeatIntervalMs: 100,
    MaxRestartAttempts: 1,
    RestartDelayMs: 100,
    Capabilities: { ReadFiles: false, WriteFiles: false, RunCommands: false, Network: false, AllowedRoots: [] }
  };
  if (credentialFilePath !== undefined) {
    deviceNode.CredentialFilePath = credentialFilePath;
  } else {
    deviceNode.KeychainService = keychainService;
    deviceNode.KeychainAccount = keychainAccount;
  }
  return writeSecureJsonFile(join(resolve(directory), "appsettings.Production.json"), {
    DeviceNode: deviceNode,
    Resilience: { MaxRetryAttempts: 1, RetryBaseDelayMs: 20, RetryMaxDelayMs: 100, AttemptTimeoutMs: 2_000, TotalTimeoutMs: 5_000 }
  });
}

export async function writeSecureJsonFile(path, value) {
  assertPath(path, "path");
  const directory = dirname(path);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await chmod(path, 0o600);
  return path;
}

function assertDirectory(value) {
  assertPath(value, "directory");
}

function assertPath(value, name) {
  if (typeof value !== "string" || !isAbsolute(value) || resolve(value) === "/") {
    throw new Error(`${name} must be an explicit absolute path other than '/'.`);
  }
}

function assertSecret(value, name, minimumLength) {
  if (typeof value !== "string" || value.length < minimumLength || /[\r\n]/.test(value)) {
    throw new Error(`${name} is required and must not contain newlines.`);
  }
}

function assertUrl(value, name) {
  if (typeof value !== "string" || !/^https?:\/\//i.test(value)) {
    throw new Error(`${name} must be an HTTP(S) URL.`);
  }
}

function assertUuid(value, name) {
  if (typeof value !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
    throw new Error(`${name} must be a UUID.`);
  }
}

function assertSafeText(value, name) {
  if (typeof value !== "string" || value.length === 0 || value.length > 200 || /[\r\n]/.test(value)) {
    throw new Error(`${name} must be bounded text.`);
  }
}

const currentFile = fileURLToPath(import.meta.url);
if (process.argv[1] !== undefined && resolve(process.argv[1]) === currentFile) {
  console.error("secure-service-config.mjs is a library; use launchd-smoke-macos.sh or an explicit import.");
  process.exitCode = 2;
}
