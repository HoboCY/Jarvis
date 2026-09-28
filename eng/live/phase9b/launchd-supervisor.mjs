import { randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { launchctl, launchdDomain, isServiceNotFoundError, assertSafeServiceLabel } from "../../scripts/launchd-service.mjs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { scanKnownSecrets } from "./evidence.mjs";

const RUN_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const OWNER_DIRECTORY_MODE = 0o700;
const OWNER_FILE_MODE = 0o600;
const MAX_PLIST_BYTES = 32 * 1024;
const MAX_STATUS_BYTES = 16 * 1024;
const MAX_LOG_BYTES = 512 * 1024;
const SENSITIVE_PATH_PATTERN = /(?:bearer|secret|token|credential|api[_-]?key)/i;

const SERVICE_KINDS = Object.freeze(["api", "device"]);

/**
 * Owns only the API and Device Node launchd jobs for one Phase 9B run.
 * Desktop remains a foreground process because it is the UI under test.
 *
 * The existing launchd installer is intentionally not used here: its
 * replacement helper can bootout an already-loaded label without proving that
 * the plist belongs to this run. This adapter proves the plist identity before
 * every bootout and never takes over an unrelated label.
 */
export class LaunchdSupervisor {
  #root;
  #runId;
  #domain;
  #launchctlRunner;
  #entries;
  #installed = new Set();
  #secretValues;

  constructor({
    root,
    runId,
    apiExecutable,
    apiWorkingDirectory,
    deviceExecutable,
    deviceWorkingDirectory,
    apiPort,
    apiHost = "127.0.0.1",
    launchctlRunner = launchctl,
    uid,
    secretValues = []
  } = {}) {
    this.#root = requireAbsolute(root, "UNSAFE_TEMP_ROOT");
    if (!RUN_ID_PATTERN.test(runId ?? "")) {
      throw safeError("INVALID_RUN_ID", "Run id is invalid.");
    }
    this.#runId = runId;
    try {
      this.#domain = launchdDomain(uid ?? process.getuid?.());
    } catch (error) {
      throw safeError("LAUNCHD_UNAVAILABLE", "A launchd user domain is unavailable.", error);
    }
    if (typeof launchctlRunner !== "function") {
      throw safeError("LAUNCHD_UNAVAILABLE", "The launchctl boundary is unavailable.");
    }
    this.#launchctlRunner = launchctlRunner;
    if (!Number.isSafeInteger(apiPort) || apiPort < 1 || apiPort > 65_535) {
      throw safeError("PORT_ALLOCATION_FAILED", "The launchd API port is invalid.");
    }
    if (typeof apiHost !== "string" || !/^127\.0\.0\.1$/.test(apiHost)) {
      throw safeError("UNSAFE_PROCESS_ENVIRONMENT", "The launchd API host must be loopback.");
    }
    this.#entries = new Map([
      ["api", this.#createEntry("api", apiExecutable, apiWorkingDirectory)],
      ["device", this.#createEntry("device", deviceExecutable, deviceWorkingDirectory)]
    ]);
    this.#secretValues = [...new Set((secretValues ?? [])
      .filter((value) => typeof value === "string" && value.length > 0 && value.length <= 4096))];
    this.apiPort = apiPort;
    this.apiHost = apiHost;
  }

  get labels() {
    return Object.fromEntries([...this.#entries].map(([kind, entry]) => [kind, entry.label]));
  }

  get plistPaths() {
    return Object.fromEntries([...this.#entries].map(([kind, entry]) => [kind, entry.plist]));
  }

  get logPaths() {
    return Object.fromEntries([...this.#entries].map(([kind, entry]) => [kind, entry.logDirectory]));
  }

  isInstalled(kind) {
    return this.#installed.has(kind);
  }

  registerSecret(value) {
    if (typeof value !== "string" || value.length === 0 || value.length > 4096) {
      throw safeError("OBSERVATION_INVALID", "The launchd secret boundary is invalid.");
    }
    if (!this.#secretValues.includes(value)) {
      this.#secretValues = [...this.#secretValues, value];
    }
  }

  async startService(kind) {
    const entry = this.#entry(kind);
    await assertOwnedRoot(this.#root, this.#runId);
    await assertLaunchable(entry);
    if (this.#installed.has(kind)) {
      return { kind, label: entry.label, status: "STARTED" };
    }
    await this.#assertServiceAbsent(entry);
    await ensurePrivateDirectory(dirname(entry.plist), this.#root);
    await ensurePrivateDirectory(entry.logDirectory, this.#root);
    await ensurePrivateLogFile(join(entry.logDirectory, "stdout.log"), this.#root);
    await ensurePrivateLogFile(join(entry.logDirectory, "stderr.log"), this.#root);
    const plist = renderOwnedLaunchdPlist({
      kind,
      label: entry.label,
      executable: entry.executable,
      workingDirectory: entry.workingDirectory,
      plistPath: entry.plist,
      logDirectory: entry.logDirectory,
      apiHost: this.apiHost,
      apiPort: String(this.apiPort)
    });
    assertNoKnownSecret(plist, this.#secretValues);
    await writePrivateText(entry.plist, plist, this.#root);
    try {
      await this.#invoke(["bootstrap", this.#domain, entry.plist]);
    } catch (error) {
      await this.#rememberLoadedService(entry);
      throw safeError("LAUNCHD_BOOTSTRAP_FAILED", "The owned launchd service could not be bootstrapped.", error);
    }
    this.#installed.add(kind);
    const state = await this.#readService(entry);
    if (!state.exists || !state.owned) {
      throw safeError("LAUNCHD_SERVICE_UNREADY", "The owned launchd service did not load.");
    }
    await this.scanOutput();
    return { kind, label: entry.label, status: "STARTED" };
  }

  async serviceState(kind) {
    const entry = this.#entry(kind);
    const state = await this.#readService(entry);
    return {
      kind,
      label: entry.label,
      installed: this.#installed.has(kind),
      exists: state.exists,
      owned: state.owned,
      running: state.exists && state.owned && state.running
    };
  }

  async scanOutput() {
    for (const entry of this.#entries.values()) {
      for (const logFile of [join(entry.logDirectory, "stdout.log"), join(entry.logDirectory, "stderr.log")]) {
        const metadata = await lstat(logFile).catch(() => null);
        if (metadata === null) {
          continue;
        }
        if (metadata.isSymbolicLink() || !metadata.isFile() || metadata.size > MAX_LOG_BYTES) {
          throw safeError("OBSERVATION_INVALID", "The launchd log boundary is invalid.");
        }
        const text = await readFile(logFile, "utf8");
        if (scanKnownSecrets(text, this.#secretValues)) {
          throw safeError("SECRET_DETECTED", "Known secret detected in launchd output.");
        }
      }
    }
  }

  async stopAll() {
    let failure;
    for (const kind of ["device", "api"]) {
      try {
        await this.stopService(kind);
      } catch (error) {
        failure ??= error;
      }
    }
    if (failure !== undefined) {
      throw safeError("LAUNCHD_CLEANUP_FAILED", "Owned launchd cleanup failed.", failure);
    }
    return true;
  }

  async stopService(kind) {
    const entry = this.#entry(kind);
    await assertOwnedRoot(this.#root, this.#runId);
    const state = await this.#readService(entry);
    if (state.exists) {
      if (!state.owned) {
        throw safeError("LAUNCHD_OWNERSHIP_INVALID", "The launchd label is not owned by this run.");
      }
      await this.#invoke(["bootout", this.#domain, entry.plist]);
      const after = await this.#readService(entry);
      if (after.exists) {
        throw safeError("LAUNCHD_CLEANUP_FAILED", "The owned launchd service remained loaded.");
      }
    }
    await unlinkOwnedFile(entry.plist, this.#root);
    this.#installed.delete(kind);
    return true;
  }

  #createEntry(kind, executable, workingDirectory) {
    if (!SERVICE_KINDS.includes(kind)) {
      throw safeError("LAUNCHD_SERVICE_INVALID", "The launchd service kind is invalid.");
    }
    const executablePath = requireAbsolute(executable, "LAUNCHD_EXECUTABLE_INVALID");
    const workingDirectoryPath = requireAbsolute(workingDirectory, "LAUNCHD_CWD_INVALID");
    const label = `com.hobocy.jarvis.phase9b.${this.#runId}.${kind}`;
    try {
      assertSafeServiceLabel(label);
    } catch (error) {
      throw safeError("LAUNCHD_LABEL_INVALID", "The launchd service label is invalid.", error);
    }
    const serviceRoot = join(this.#root, "launchd");
    return {
      kind,
      label,
      executable: executablePath,
      workingDirectory: workingDirectoryPath,
      plist: join(serviceRoot, `${kind}.plist`),
      logDirectory: join(serviceRoot, "logs", kind)
    };
  }

  #entry(kind) {
    const entry = this.#entries.get(kind);
    if (entry === undefined) {
      throw safeError("LAUNCHD_SERVICE_INVALID", "The launchd service kind is invalid.");
    }
    return entry;
  }

  async #assertServiceAbsent(entry) {
    const state = await this.#readService(entry);
    if (state.exists) {
      throw safeError("LAUNCHD_OWNERSHIP_INVALID", "The launchd label is already loaded.");
    }
    const metadata = await lstat(entry.plist).catch(() => null);
    if (metadata !== null) {
      throw safeError("LAUNCHD_OWNERSHIP_INVALID", "The launchd plist path is already occupied.");
    }
  }

  async #rememberLoadedService(entry) {
    const state = await this.#readService(entry).catch(() => null);
    if (state?.exists && state.owned) {
      this.#installed.add(entry.kind);
    }
  }

  async #readService(entry) {
    let result;
    try {
      result = await this.#invoke(["print", `${this.#domain}/${entry.label}`]);
    } catch (error) {
      if (isServiceNotFoundError(error)) {
        return { exists: false, owned: false, running: false };
      }
      throw error;
    }
    const output = boundedText(result?.stdout ?? result);
    const labelPattern = new RegExp(`(?:^|\\n)\\s*${escapeRegex(`${this.#domain}/${entry.label}`)}\\s*=\\s*\\{`);
    const pathMatch = output.match(/(?:^|\n)\s*path\s*=\s*(.+?)\s*(?:\n|$)/i);
    const owned = labelPattern.test(output) && pathMatch?.[1] === entry.plist;
    if (!owned) {
      return { exists: true, owned: false, running: false };
    }
    const running = /(?:^|\n)\s*state\s*=\s*running\b/i.test(output);
    return { exists: true, owned: true, running };
  }

  async #invoke(args) {
    try {
      const result = await this.#launchctlRunner(args, { dryRun: false });
      if (result?.status !== undefined && result.status !== 0) {
        const error = new Error("launchctl operation failed.");
        error.status = result.status;
        error.stderr = boundedText(result.stderr);
        throw error;
      }
      return result;
    } catch (error) {
      if (isServiceNotFoundError(error)) {
        throw error;
      }
      throw safeError("LAUNCHD_OPERATION_FAILED", "The launchd operation failed.", error);
    }
  }
}

export function renderOwnedLaunchdPlist({
  kind,
  label,
  executable,
  workingDirectory,
  plistPath,
  logDirectory,
  apiHost = "127.0.0.1",
  apiPort
} = {}) {
  if (!SERVICE_KINDS.includes(kind) || typeof label !== "string" || typeof executable !== "string"
      || typeof workingDirectory !== "string" || typeof plistPath !== "string" || typeof logDirectory !== "string") {
    throw safeError("LAUNCHD_PLIST_INVALID", "Launchd plist values are invalid.");
  }
  if (!/^127\.0\.0\.1$/.test(apiHost) || !/^\d{1,5}$/.test(String(apiPort ?? ""))) {
    throw safeError("LAUNCHD_PLIST_INVALID", "Launchd plist networking is invalid.");
  }
  for (const value of [label, executable, workingDirectory, plistPath, logDirectory]) {
    if ((!isAbsolute(value) && value !== label) || value.includes("\n") || value.includes("\r")
        || SENSITIVE_PATH_PATTERN.test(value)) {
      throw safeError("LAUNCHD_PLIST_INVALID", "Launchd plist paths are invalid.");
    }
  }
  try {
    assertSafeServiceLabel(label);
  } catch (error) {
    throw safeError("LAUNCHD_LABEL_INVALID", "The launchd service label is invalid.", error);
  }
  if (kind === "api") {
    return plistText([
      ["Label", label],
      ["ProgramArguments", [executable, "--urls", `http://${apiHost}:${apiPort}`]],
      ["WorkingDirectory", workingDirectory],
      ["RunAtLoad", true],
      ["KeepAlive", false],
      ["Umask", 63],
      ["ProcessType", "Interactive"],
      ["EnvironmentVariables", { DOTNET_ENVIRONMENT: "Production" }],
      ["StandardOutPath", join(logDirectory, "stdout.log")],
      ["StandardErrorPath", join(logDirectory, "stderr.log")]
    ]);
  }
  return plistText([
    ["Label", label],
    ["ProgramArguments", [executable]],
    ["WorkingDirectory", workingDirectory],
    ["RunAtLoad", true],
    ["KeepAlive", false],
    ["Umask", 63],
    ["ProcessType", "Interactive"],
    ["EnvironmentVariables", { DOTNET_ENVIRONMENT: "Production" }],
    ["StandardOutPath", join(logDirectory, "stdout.log")],
    ["StandardErrorPath", join(logDirectory, "stderr.log")]
  ]);
}

async function assertOwnedRoot(root, expectedRunId) {
  const metadata = await lstat(root).catch(() => null);
  if (metadata === null || metadata.isSymbolicLink() || !metadata.isDirectory()
      || (metadata.mode & 0o777) !== OWNER_DIRECTORY_MODE) {
    throw safeError("OWNERSHIP_MARKER_INVALID", "The live runtime root is not owner-only.");
  }
  const markerPath = join(root, ".phase9b-owner.json");
  const markerMetadata = await lstat(markerPath).catch(() => null);
  if (markerMetadata === null || markerMetadata.isSymbolicLink() || !markerMetadata.isFile()) {
    throw safeError("OWNERSHIP_MARKER_INVALID", "The live runtime marker is invalid.");
  }
  let marker;
  try {
    marker = JSON.parse(await readFile(markerPath, "utf8"));
  } catch {
    throw safeError("OWNERSHIP_MARKER_INVALID", "The live runtime marker is invalid.");
  }
  if (marker?.schemaVersion !== 1 || marker.runId !== expectedRunId || marker.pid !== process.pid) {
    throw safeError("OWNERSHIP_MARKER_INVALID", "The live runtime marker is invalid.");
  }
}

async function assertLaunchable(entry) {
  const executable = await lstat(entry.executable).catch(() => null);
  if (executable === null || executable.isSymbolicLink() || !executable.isFile()
      || (executable.mode & 0o111) === 0) {
    throw safeError("LAUNCHD_EXECUTABLE_INVALID", "The launchd executable is unavailable.");
  }
  const workingDirectory = await lstat(entry.workingDirectory).catch(() => null);
  if (workingDirectory === null || workingDirectory.isSymbolicLink() || !workingDirectory.isDirectory()
      || (workingDirectory.mode & 0o077) !== 0) {
    throw safeError("LAUNCHD_CWD_INVALID", "The launchd working directory is unsafe.");
  }
}

async function ensurePrivateDirectory(path, root) {
  const absolute = resolve(path);
  if (!isWithin(absolute, root)) {
    throw safeError("UNSAFE_PRIVATE_PATH", "The launchd path escaped the live runtime root.");
  }
  const parts = absolute.slice(resolve(root).length).split("/").filter(Boolean);
  let current = resolve(root);
  for (const part of parts) {
    current = join(current, part);
    const metadata = await lstat(current).catch(() => null);
    if (metadata?.isSymbolicLink() || metadata !== null && !metadata.isDirectory()) {
      throw safeError("UNSAFE_PRIVATE_PATH", "The launchd path contains a symbolic link.");
    }
    if (metadata === null) {
      await mkdir(current, { mode: OWNER_DIRECTORY_MODE });
    }
    await chmod(current, OWNER_DIRECTORY_MODE);
  }
}

async function writePrivateText(path, text, root) {
  if (typeof text !== "string" || Buffer.byteLength(text, "utf8") > MAX_PLIST_BYTES) {
    throw safeError("PRIVATE_FILE_INTEGRITY", "The launchd plist is too large.");
  }
  const metadata = await lstat(path).catch(() => null);
  if (metadata !== null) {
    throw safeError("UNSAFE_PRIVATE_PATH", "The launchd plist path is already occupied.");
  }
  const parent = dirname(path);
  await ensurePrivateDirectory(parent, root);
  const temporaryPath = join(parent, `.${randomUUID()}.tmp`);
  let handle;
  try {
    handle = await open(temporaryPath, "wx", OWNER_FILE_MODE);
    await handle.writeFile(text, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await chmod(temporaryPath, OWNER_FILE_MODE);
    await rename(temporaryPath, path);
    const readback = await readFile(path, "utf8");
    if (readback !== text) {
      throw safeError("PRIVATE_FILE_INTEGRITY", "The launchd plist readback failed.");
    }
  } catch (error) {
    await handle?.close().catch(() => {});
    await unlink(temporaryPath).catch(() => {});
    throw error;
  }
}

async function ensurePrivateLogFile(path, root) {
  const absolute = resolve(path);
  if (!isWithin(absolute, root)) {
    throw safeError("UNSAFE_PRIVATE_PATH", "The launchd log path escaped the live runtime root.");
  }
  await ensurePrivateDirectory(dirname(absolute), root);
  const metadata = await lstat(absolute).catch(() => null);
  if (metadata?.isSymbolicLink() || metadata !== null && !metadata.isFile()
      || metadata !== null && (metadata.mode & 0o077) !== 0) {
    throw safeError("UNSAFE_PRIVATE_PATH", "The launchd log path is unsafe.");
  }
  let handle;
  try {
    handle = await open(absolute, metadata === null ? "wx" : "r+", OWNER_FILE_MODE);
    await handle.truncate(0);
    await handle.sync();
    await handle.close();
    handle = undefined;
    await chmod(absolute, OWNER_FILE_MODE);
  } catch (error) {
    await handle?.close().catch(() => {});
    throw safeError("PRIVATE_FILE_INTEGRITY", "The launchd log file could not be prepared.", error);
  }
}

async function unlinkOwnedFile(path, root) {
  const absolute = resolve(path);
  if (!isWithin(absolute, root)) {
    throw safeError("UNSAFE_PRIVATE_PATH", "The launchd plist escaped the live runtime root.");
  }
  const metadata = await lstat(absolute).catch(() => null);
  if (metadata === null) {
    return;
  }
  if (metadata.isSymbolicLink() || !metadata.isFile()) {
    throw safeError("UNSAFE_PRIVATE_PATH", "The launchd plist path is unsafe.");
  }
  await unlink(absolute);
}

function plistText(entries) {
  const body = entries.map(([key, value]) => `${xml("  <key>", key, "</key>")}\n${plistValue(value, 2)}`).join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0">\n<dict>\n${body}\n</dict>\n</plist>\n`;
}

function plistValue(value, indent) {
  const padding = " ".repeat(indent);
  if (typeof value === "boolean") {
    return `${padding}<${value ? "true" : "false"}/>`;
  }
  if (typeof value === "number" && Number.isSafeInteger(value)) {
    return `${padding}<integer>${value}</integer>`;
  }
  if (Array.isArray(value)) {
    return `${padding}<array>\n${value.map((item) => plistValue(item, indent + 2)).join("\n")}\n${padding}</array>`;
  }
  if (value !== null && typeof value === "object") {
    return `${padding}<dict>\n${Object.entries(value).map(([key, item]) => `${" ".repeat(indent + 2)}<key>${escapeXml(key)}</key>\n${plistValue(item, indent + 2)}`).join("\n")}\n${padding}</dict>`;
  }
  return `${padding}<string>${escapeXml(String(value))}</string>`;
}

function xml(prefix, value, suffix) {
  return `${prefix}${escapeXml(value)}${suffix}`;
}

function escapeXml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function assertNoKnownSecret(value, secretValues) {
  if (secretValues.some((secret) => value.includes(secret))) {
    throw safeError("SECRET_DETECTED", "A launchd plist contains a known secret.");
  }
}

function boundedText(value) {
  return typeof value === "string" ? value.slice(0, MAX_STATUS_BYTES) : "";
}

function requireAbsolute(value, code) {
  if (typeof value !== "string" || !isAbsolute(value) || value.length > 1024) {
    throw safeError(code, "The launchd path must be absolute.");
  }
  return resolve(value);
}

function isWithin(candidate, parent) {
  const child = resolve(candidate);
  const root = resolve(parent);
  const remainder = child.slice(root.length);
  return remainder === "" || remainder.startsWith("/");
}

function safeError(code, message, cause) {
  const error = new Error(message, cause === undefined ? undefined : { cause });
  error.code = code;
  return error;
}
