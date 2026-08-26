import { chmod, lstat, mkdir, realpath, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, parse, relative, resolve } from "node:path";
import { userInfo } from "node:os";
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
  codexHome,
  credentialFilePath,
  keychainService,
  keychainAccount
}) {
  assertDirectory(directory);
  assertUrl(apiBaseUrl, "apiBaseUrl");
  assertUuid(deviceId, "deviceId");
  const resolvedCodexHome = await ensureSecureCodexHome(codexHome);
  if (credentialFilePath !== undefined) {
    assertPath(credentialFilePath, "credentialFilePath");
  } else {
    assertSafeText(keychainService, "keychainService");
    assertSafeText(keychainAccount, "keychainAccount");
  }
  const deviceNode = {
    ApiBaseUrl: apiBaseUrl,
    DeviceId: "00000000-0000-0000-0000-000000000000",
    CodexHome: resolvedCodexHome,
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
  if (typeof value !== "string" || !isAbsolute(value)) {
    throw new Error(`${name} must be an explicit absolute path other than '/'.`);
  }

  const resolved = resolve(value);
  if (resolved === parse(resolved).root) {
    throw new Error(`${name} must be an explicit absolute path other than '/'.`);
  }

  return resolved;
}

/**
 * Validates an isolated Codex home without creating, chmod'ing, or writing anything.
 * The optional userHome is a test/verification seam and is never accepted by the
 * runtime configuration writer.
 */
export async function validateIndependentCodexHomePath(value, configuredUserHome = userInfo().homedir) {
  const resolvedPath = assertPath(value, "codexHome");
  const resolvedUserHome = assertPath(configuredUserHome, "userHome");
  const comparison = process.platform === "win32" || process.platform === "darwin"
    ? "insensitive"
    : "sensitive";
  const userCodexHome = resolve(join(resolvedUserHome, ".codex"));
  if (isSameOrDescendant(resolvedPath, userCodexHome, comparison)) {
    throw new Error("codexHome must be an independent directory, not the user's ~/.codex.");
  }

  const userHomeInspection = await inspectExistingPath(resolvedUserHome, "userHome");
  if (!userHomeInspection.exists || !userHomeInspection.metadata.isDirectory()) {
    throw new Error("userHome must be an existing directory.");
  }
  const candidateInspection = await inspectExistingPath(resolvedPath, "codexHome");
  await rejectPhysicalUserCodexAlias(
    resolvedPath,
    candidateInspection,
    resolvedUserHome,
    userHomeInspection,
    comparison);

  return resolvedPath;
}

async function ensureSecureCodexHome(value) {
  const trustedUserHome = userInfo().homedir;
  const resolvedPath = await validateIndependentCodexHomePath(value, trustedUserHome);

  await mkdir(resolvedPath, { recursive: true, mode: 0o700 });
  await validateIndependentCodexHomePath(resolvedPath, trustedUserHome);

  await chmod(resolvedPath, 0o700);
  return resolvedPath;
}

async function inspectExistingPath(path, name) {
  const root = parse(path).root;
  const segments = path.slice(root.length).split(/[\\/]+/).filter(Boolean);
  let current = root;
  let lastExisting = root;
  let metadata = await lstat(root);
  for (const [index, segment] of segments.entries()) {
    current = join(current, segment);
    try {
      metadata = await lstat(current);
    } catch (error) {
      if (error?.code === "ENOENT" || error?.code === "ENOTDIR") {
        return { exists: false, lastExisting, metadata };
      }

      throw error;
    }

    if (metadata.isSymbolicLink()) {
      throw new Error(`${name} must not contain a symbolic-link ancestor.`);
    }
    if (!metadata.isDirectory() && index < segments.length - 1) {
      throw new Error(`${name} must have directory ancestors.`);
    }
    lastExisting = current;
  }

  return { exists: true, lastExisting, metadata };
}

async function rejectPhysicalUserCodexAlias(
  candidatePath,
  candidateInspection,
  userHomePath,
  userHomeInspection,
  comparison) {
  const physicalUserHome = await physicalPath(userHomePath, userHomeInspection);
  let physicalUserCodexHome = resolve(physicalUserHome, ".codex");
  try {
    physicalUserCodexHome = await realpath(physicalUserCodexHome);
  } catch (error) {
    if (error?.code !== "ENOENT" && error?.code !== "ENOTDIR") {
      throw error;
    }
  }

  const physicalCandidate = await physicalPath(candidatePath, candidateInspection);
  if (isSameOrDescendant(physicalCandidate, physicalUserCodexHome, comparison)) {
    throw new Error("codexHome must not alias the user's ~/.codex.");
  }
}

async function physicalPath(path, inspection) {
  const physicalExisting = await realpath(inspection.lastExisting);
  const suffix = relative(inspection.lastExisting, path);
  return resolve(physicalExisting, suffix);
}

function isSameOrDescendant(path, basePath, comparison) {
  const normalizedPath = normalizeForComparison(path, comparison);
  const normalizedBase = normalizeForComparison(basePath, comparison);
  const separator = process.platform === "win32" ? "\\" : "/";
  return normalizedPath === normalizedBase
    || normalizedPath.startsWith(`${normalizedBase}${separator}`);
}

function normalizeForComparison(path, comparison) {
  const resolved = resolve(path);
  return comparison === "insensitive" ? resolved.toLocaleLowerCase("en-US") : resolved;
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
