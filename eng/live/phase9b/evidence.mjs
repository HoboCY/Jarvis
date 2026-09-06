import { createHash, randomUUID } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat
} from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { DEFAULT_BUDGETS } from "./budgets.mjs";

const SCHEMA_VERSION = 1;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const COMMIT_SHA_PATTERN = /^[a-f0-9]{40,64}$/;
const RUN_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const JARVIS_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const IDENTIFIER_PATTERN = /^[a-z][a-z0-9._:-]{1,127}$/;
const VERSION_PATTERN = /^\d+(?:\.\d+){1,3}$/;
const UTC_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const KNOWN_OS_VALUES = new Set(["darwin", "linux", "win32", "unknown", "unsupported"]);
const KNOWN_ARCH_VALUES = new Set(["arm64", "x64", "unknown", "unsupported"]);
const UNSAFE_ARTIFACT_PATH_PATTERN = /(?:^|\/)(?:[^/]*(?:\.db|\.sqlite3?|\.wav|\.mp3|\.m4a|\.jsonl|\.env)|(?:database|audio|transcript|prompt|headers?|provider(?:[-_.]|$)|(?:provider|request|response)[-_]?(?:body|dto|payload))(?:$|[-_./]))/i;
const STATUS_VALUES = new Set(["PASS", "FAIL", "BLOCKED", "UNVERIFIED"]);
const TOP_LEVEL_STATUS_VALUES = new Set([
  ...STATUS_VALUES,
  "LIVE_PARTIAL",
  "BLOCKED_CREDENTIALS",
  "BLOCKED_TOOLCHAIN",
  "BLOCKED_PROVIDER_CONFIG",
  "BLOCKED_PROVIDER_ACCESS",
  "BLOCKED_CODEX_AUTH",
  "LIVE_BUDGET_EXHAUSTED"
]);
const ERROR_CATEGORIES = new Set([
  "MISSING_CREDENTIALS",
  "BLOCKED_CREDENTIALS",
  "BLOCKED_PROVIDER_ACCESS",
  "BLOCKED_CODEX_AUTH",
  "SCENARIO_DRIVER_UNAVAILABLE",
  "SCENARIO_DRIVER_FAILED",
  "TIMEOUT",
  "BUDGET_EXHAUSTED",
  "UNSUPPORTED_DEEPSEEK_BACKGROUND",
  "PROCESS_START_FAILED",
  "PROCESS_ERROR",
  "SECRET_DETECTED",
  "INVALID_PROVIDER_CONFIG",
  "BLOCKED_TOOLCHAIN",
  "PLATFORM_UNSUPPORTED",
  "VALIDATION_FAILED",
  "CLEANUP_FAILED",
  "UNVERIFIED"
]);
const BUDGET_KEYS = Object.keys(DEFAULT_BUDGETS);
const SENSITIVE_KEY_PATTERN = /(?:api[-_]?key|access[-_]?token|bearer|authorization|headers?|prompt|transcript|database|audio|environment|provider[-_]?body|external[-_]?id)/i;
const UNSUPPORTED_DEEPSEEK_SCENARIOS = new Set([
  "responses-background-retrieve",
  "responses-background-cancel",
  "background-retrieve",
  "background-cancel"
]);

// A PASS report is meaningful only after the full A-J acceptance matrix has
// been observed. Individual scenarios may still be recorded as partial while
// the Desktop driver is being built.
export const REQUIRED_SCENARIO_IDS = Object.freeze([
  "isolated-installation",
  "realtime",
  "delegated-responses",
  "restart-cancellation",
  "local-read-task",
  "user-input",
  "deny",
  "approve-once",
  "device-node-restart",
  "cold-start"
]);

export function createEvidence(input = {}) {
  const evidence = {
    schemaVersion: SCHEMA_VERSION,
    runId: input.runId,
    baselineSha: input.baselineSha,
    candidateSha: input.candidateSha,
    startedAtUtc: input.startedAtUtc,
    finishedAtUtc: input.finishedAtUtc,
    status: input.status,
    platform: input.platform,
    toolchain: input.toolchain,
    provider: input.provider,
    budgets: input.budgets,
    scenarios: input.scenarios ?? [],
    artifacts: input.artifacts ?? [],
    errors: input.errors ?? [],
    secretScan: input.secretScan ?? { passed: true }
  };
  for (const [key, value] of Object.entries(input)) {
    if (!Object.hasOwn(evidence, key)) {
      evidence[key] = value;
    }
  }
  validateEvidence(evidence);
  return evidence;
}

export function validateEvidence(evidence) {
  assertPlainObject(evidence);
  assertExactKeys(evidence, [
    "schemaVersion",
    "runId",
    "baselineSha",
    "candidateSha",
    "startedAtUtc",
    "finishedAtUtc",
    "status",
    "platform",
    "toolchain",
    "provider",
    "budgets",
    "scenarios",
    "artifacts",
    "errors",
    "secretScan"
  ]);
  if (evidence.schemaVersion !== SCHEMA_VERSION
      || !RUN_ID_PATTERN.test(evidence.runId)
      || !COMMIT_SHA_PATTERN.test(evidence.baselineSha)
      || !COMMIT_SHA_PATTERN.test(evidence.candidateSha)
      || !UTC_PATTERN.test(evidence.startedAtUtc)
      || !UTC_PATTERN.test(evidence.finishedAtUtc)
      || !TOP_LEVEL_STATUS_VALUES.has(evidence.status)) {
    throw invalidEvidence();
  }
  if (Date.parse(evidence.finishedAtUtc) < Date.parse(evidence.startedAtUtc)) {
    throw invalidEvidence();
  }
  validatePlatform(evidence.platform);
  validateToolchain(evidence.toolchain);
  validateProvider(evidence.provider);
  validateBudgets(evidence.budgets);
  if (!Array.isArray(evidence.scenarios) || evidence.scenarios.length === 0 || evidence.scenarios.length > 32) {
    throw invalidEvidence();
  }
  for (const scenario of evidence.scenarios) {
    validateScenario(scenario, evidence.provider);
  }
  if (!Array.isArray(evidence.artifacts) || evidence.artifacts.length > 128) {
    throw invalidEvidence();
  }
  for (const artifact of evidence.artifacts) {
    validateArtifact(artifact);
  }
  if (new Set(evidence.artifacts.map((artifact) => artifact.path)).size !== evidence.artifacts.length) {
    throw invalidEvidence();
  }
  if (!Array.isArray(evidence.errors) || evidence.errors.length > 32) {
    throw invalidEvidence();
  }
  for (const error of evidence.errors) {
    assertPlainObject(error);
    assertExactKeys(error, ["category"]);
    if (!ERROR_CATEGORIES.has(error.category)) {
      throw invalidEvidence();
    }
  }
  const hasBudgetError = evidence.errors.some((error) => error.category === "BUDGET_EXHAUSTED");
  const hasSecretError = evidence.errors.some((error) => error.category === "SECRET_DETECTED");
  if (evidence.status === "LIVE_BUDGET_EXHAUSTED" && !hasBudgetError) {
    throw invalidEvidence();
  }
  if (hasBudgetError
      && evidence.status !== "LIVE_BUDGET_EXHAUSTED"
      && !(evidence.status === "FAIL" && hasSecretError)) {
    throw invalidEvidence();
  }
  assertPlainObject(evidence.secretScan);
  assertExactKeys(evidence.secretScan, ["passed"]);
  if (typeof evidence.secretScan.passed !== "boolean" || evidence.secretScan.passed !== true) {
    throw invalidEvidence();
  }
  if (evidence.status === "PASS") {
    const scenarioIds = new Set(evidence.scenarios.map((scenario) => scenario.id));
    if (evidence.scenarios.length !== REQUIRED_SCENARIO_IDS.length
        || scenarioIds.size !== REQUIRED_SCENARIO_IDS.length
        || REQUIRED_SCENARIO_IDS.some((id) => !scenarioIds.has(id))
        || evidence.scenarios.some((scenario) => scenario.status !== "PASS")
        || evidence.errors.length !== 0) {
      throw invalidEvidence();
    }
  }
  if (containsSecretLikeText(evidence)) {
    throw invalidEvidence();
  }
  return true;
}

export function hashExternalId(value) {
  if (typeof value !== "string" || value.length === 0 || value.length > 512) {
    throw invalidEvidence();
  }
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export function summarizeOutput(value, { maxBytes = 4 * 1024 * 1024 } = {}) {
  if (!Buffer.isBuffer(value) && typeof value !== "string") {
    throw invalidEvidence();
  }
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value, "utf8");
  if (bytes.length > maxBytes) {
    throw invalidEvidence();
  }
  return {
    length: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex")
  };
}

export function scanKnownSecrets(value, secretValues = []) {
  let serialized;
  try {
    serialized = Buffer.isBuffer(value)
      ? value.toString("utf8")
      : typeof value === "string" ? value : JSON.stringify(value);
  } catch {
    return true;
  }
  if (typeof serialized !== "string") {
    return false;
  }
  for (const secret of secretValues) {
    if (typeof secret === "string" && secret.length > 0 && serialized.includes(secret)) {
      return true;
    }
  }
  return /\b(?:sk-(?:proj|admin|service|svcacct)-[A-Za-z0-9_-]{12,}|Bearer\s+[A-Za-z0-9._-]{16,})\b/.test(serialized);
}

export async function writeLiveEvidence({ repositoryRoot = process.cwd(), evidence, secretValues = [] } = {}) {
  validateEvidence(evidence);
  if (scanKnownSecrets(evidence, secretValues)) {
    throw safeError("SECRET_DETECTED", "Evidence contains a known secret.");
  }
  const repo = requireAbsolute(repositoryRoot);
  const expectedRoot = join(repo, "artifacts", "live", "phase9b");
  const directory = join(expectedRoot, evidence.runId);
  await ensureDirectory(join(repo, "artifacts"), 0o755, repo, { chmodExisting: false });
  await ensureDirectory(join(repo, "artifacts", "live"), 0o700, repo);
  await ensureDirectory(expectedRoot, 0o700, join(repo, "artifacts", "live"));
  await ensureDirectory(directory, 0o700, expectedRoot);
  const evidencePath = join(directory, "evidence.json");
  const manifestPath = join(directory, "manifest.json");
  const evidenceExisted = (await lstat(evidencePath).catch(() => null))?.isFile() === true;
  const manifestExisted = (await lstat(manifestPath).catch(() => null))?.isFile() === true;
  await validateArtifactFiles(directory, evidence.artifacts, secretValues);

  try {
    const evidenceText = `${JSON.stringify(evidence)}\n`;
    await writeAtomicText(evidencePath, evidenceText, directory);
    const evidenceSha = sha256(Buffer.from(evidenceText, "utf8"));
    const manifest = {
      schemaVersion: SCHEMA_VERSION,
      runId: evidence.runId,
      evidence: { path: "evidence.json", sha256: evidenceSha },
      artifacts: evidence.artifacts
    };
    validateManifest(manifest);
    await writeAtomicText(manifestPath, `${JSON.stringify(manifest)}\n`, directory);
    await validateEvidenceBundle(directory, { secretValues });
    return { directory, evidencePath, manifestPath };
  } catch (error) {
    if (!evidenceExisted) {
      await rm(evidencePath, { force: true }).catch(() => {});
    }
    if (!manifestExisted) {
      await rm(manifestPath, { force: true }).catch(() => {});
    }
    throw error;
  }
}

export async function validateEvidenceBundle(target, { secretValues = [] } = {}) {
  const input = requireAbsolute(target);
  const inputMetadata = await lstat(input).catch(() => null);
  if (inputMetadata === null || inputMetadata.isSymbolicLink()) {
    throw invalidEvidence();
  }
  if (!inputMetadata.isDirectory() && basename(input) !== "manifest.json") {
    throw invalidEvidence();
  }
  const directory = inputMetadata.isDirectory() ? input : join(input, "..");
  const manifestPath = inputMetadata.isDirectory() ? join(directory, "manifest.json") : input;
  const manifestMetadata = await lstat(manifestPath).catch(() => null);
  if (manifestMetadata === null || !manifestMetadata.isFile() || manifestMetadata.isSymbolicLink()) {
    throw invalidEvidence();
  }
  const manifest = parseJson(await readFile(manifestPath, "utf8"));
  validateManifest(manifest);
  const evidencePath = safeRelativePath(manifest.evidence.path);
  if (evidencePath !== "evidence.json") {
    throw invalidEvidence();
  }
  const evidenceFilePath = join(directory, evidencePath);
  const evidenceMetadata = await lstat(evidenceFilePath).catch(() => null);
  if (evidenceMetadata === null || !evidenceMetadata.isFile() || evidenceMetadata.isSymbolicLink()) {
    throw invalidEvidence();
  }
  const evidenceBytes = await readFile(evidenceFilePath);
  if (sha256(evidenceBytes) !== manifest.evidence.sha256) {
    throw invalidEvidence();
  }
  const evidence = parseJson(evidenceBytes.toString("utf8"));
  validateEvidence(evidence);
  if (evidence.runId !== manifest.runId || JSON.stringify(evidence.artifacts) !== JSON.stringify(manifest.artifacts)) {
    throw invalidEvidence();
  }
  await assertOwnerOnly(directory, 0o700);
  await validateArtifactFiles(directory, manifest.artifacts, secretValues);
  await validateBundleContents(directory, manifest.artifacts);
  await assertOwnerOnly(join(directory, "evidence.json"), 0o600);
  await assertOwnerOnly(join(directory, "manifest.json"), 0o600);
  return { status: "PASS", runId: manifest.runId };
}

export function validateRelativeArtifactPath(value) {
  return safeRelativePath(value);
}

function validatePlatform(value) {
  assertPlainObject(value);
  assertExactKeys(value, ["os", "arch", "osVersion"]);
  if (!KNOWN_OS_VALUES.has(value.os) || !KNOWN_ARCH_VALUES.has(value.arch) || !boundedText(value.osVersion, 64)) {
    throw invalidEvidence();
  }
}

function validateToolchain(value) {
  assertPlainObject(value);
  assertExactKeys(value, ["node", "pnpm", "dotnet", "codex"]);
  for (const tool of Object.values(value)) {
    if (!boundedText(tool, 32)) {
      throw invalidEvidence();
    }
  }
}

function validateProvider(value) {
  assertPlainObject(value);
  assertExactKeys(value, [
    "electronVersion",
    "realtimeProvider",
    "realtimeModel",
    "realtimeVoice",
    "responsesProvider",
    "responsesModel",
    "summarizerModel"
  ]);
  if (!VERSION_PATTERN.test(value.electronVersion)
      || value.realtimeProvider !== "AzureOpenAI"
      || value.responsesProvider !== "DeepSeek" && value.responsesProvider !== "OpenAI"
      || !boundedIdentifier(value.realtimeModel)
      || !boundedIdentifier(value.realtimeVoice)
      || !boundedIdentifier(value.responsesModel)
      || !boundedIdentifier(value.summarizerModel)) {
    throw invalidEvidence();
  }
}

function validateBudgets(value) {
  assertPlainObject(value);
  assertExactKeys(value, ["limits", "used"]);
  for (const field of ["limits", "used"]) {
    assertPlainObject(value[field]);
    assertExactKeys(value[field], BUDGET_KEYS);
    for (const key of BUDGET_KEYS) {
      const amount = value[field][key];
      if (!Number.isSafeInteger(amount) || amount < 0 || amount > DEFAULT_BUDGETS[key]) {
        throw invalidEvidence();
      }
    }
  }
  for (const key of BUDGET_KEYS) {
    if (value.used[key] > value.limits[key]) {
      throw invalidEvidence();
    }
  }
}

function validateScenario(value, provider) {
  assertPlainObject(value);
  assertAllowedKeys(value, [
    "id",
    "status",
    "startedAtUtc",
    "finishedAtUtc",
    "durationMs",
    "errorCategory",
    "counts",
    "ids",
    "output",
    "artifactPaths"
  ], ["id", "status", "startedAtUtc", "finishedAtUtc", "durationMs"]);
  if (!boundedIdentifier(value.id)
      || !STATUS_VALUES.has(value.status)
      || !UTC_PATTERN.test(value.startedAtUtc)
      || !UTC_PATTERN.test(value.finishedAtUtc)
      || !Number.isSafeInteger(value.durationMs)
      || value.durationMs < 0
      || value.durationMs > 10 * 60 * 1000) {
    throw invalidEvidence();
  }
  if (value.errorCategory !== undefined && !ERROR_CATEGORIES.has(value.errorCategory)) {
    throw invalidEvidence();
  }
  if (UNSUPPORTED_DEEPSEEK_SCENARIOS.has(value.id)
      && provider.responsesProvider === "DeepSeek"
      && value.status === "PASS") {
    throw invalidEvidence();
  }
  if (value.counts !== undefined) {
    assertPlainObject(value.counts);
    assertExactKeys(value.counts, BUDGET_KEYS);
    for (const amount of Object.values(value.counts)) {
      if (!Number.isSafeInteger(amount) || amount < 0 || amount > 128) {
        throw invalidEvidence();
      }
    }
  }
  if (value.ids !== undefined) {
    assertPlainObject(value.ids);
    assertAllowedKeys(value.ids, [
      "jarvisConversationId",
      "jarvisRealtimeSessionId",
      "jarvisTaskId",
      "jarvisNotificationId",
      "jarvisApprovalId",
      "realtimeSessionIdHash",
      "responseIdHash",
      "codexTaskIdHash",
      "codexThreadIdHash",
      "codexTurnIdHash"
    ]);
    for (const [key, id] of Object.entries(value.ids)) {
      if (key.endsWith("Hash")) {
        if (!SHA256_PATTERN.test(id)) {
          throw invalidEvidence();
        }
      } else if (!JARVIS_ID_PATTERN.test(id)) {
        throw invalidEvidence();
      }
    }
  }
  if (value.output !== undefined) {
    assertPlainObject(value.output);
    assertExactKeys(value.output, ["length", "sha256"]);
    if (!Number.isSafeInteger(value.output.length) || value.output.length < 0 || value.output.length > 4 * 1024 * 1024
        || !SHA256_PATTERN.test(value.output.sha256)) {
      throw invalidEvidence();
    }
  }
  if (value.artifactPaths !== undefined) {
    if (!Array.isArray(value.artifactPaths) || value.artifactPaths.length > 32) {
      throw invalidEvidence();
    }
    for (const path of value.artifactPaths) {
      assertArtifactPathSafe(path);
    }
  }
}

function validateArtifact(value) {
  assertPlainObject(value);
  assertAllowedKeys(value, ["path", "sha256", "bytes"], ["path", "sha256"]);
  assertArtifactPathSafe(value.path);
  if (value.path === "evidence.json" || value.path === "manifest.json") {
    throw invalidEvidence();
  }
  if (!SHA256_PATTERN.test(value.sha256)
      || (value.bytes !== undefined && (!Number.isSafeInteger(value.bytes) || value.bytes < 0 || value.bytes > 4 * 1024 * 1024))) {
    throw invalidEvidence();
  }
}

function validateManifest(value) {
  assertPlainObject(value);
  assertExactKeys(value, ["schemaVersion", "runId", "evidence", "artifacts"]);
  if (value.schemaVersion !== SCHEMA_VERSION || !RUN_ID_PATTERN.test(value.runId)) {
    throw invalidEvidence();
  }
  assertPlainObject(value.evidence);
  assertExactKeys(value.evidence, ["path", "sha256"]);
  if (value.evidence.path !== "evidence.json" || !SHA256_PATTERN.test(value.evidence.sha256)) {
    throw invalidEvidence();
  }
  if (!Array.isArray(value.artifacts) || value.artifacts.length > 128) {
    throw invalidEvidence();
  }
  for (const artifact of value.artifacts) {
    validateArtifact(artifact);
  }
}

async function validateArtifactFiles(directory, artifacts, secretValues = []) {
  const directoryRealPath = await realpath(directory).catch(() => null);
  if (directoryRealPath === null) {
    throw invalidEvidence();
  }
  for (const artifact of artifacts) {
    const path = resolve(directory, safeRelativePath(artifact.path));
    if (!isWithin(path, directory)) {
      throw invalidEvidence();
    }
    const metadata = await lstat(path).catch(() => null);
    if (metadata === null || !metadata.isFile() || metadata.isSymbolicLink()) {
      throw invalidEvidence();
    }
    const actualPath = await realpath(path).catch(() => null);
    if (actualPath === null || !isWithin(actualPath, directoryRealPath)) {
      throw invalidEvidence();
    }
    await validatePrivateArtifactParents(path, directory);
    const bytes = await readFile(path);
    if (scanKnownSecrets(bytes, secretValues)) {
      throw safeError("SECRET_DETECTED", "Artifact contains a known secret.");
    }
    if (sha256(bytes) !== artifact.sha256 || artifact.bytes !== undefined && artifact.bytes !== bytes.length) {
      throw invalidEvidence();
    }
    await assertOwnerOnly(path, 0o600);
  }
}

async function validatePrivateArtifactParents(path, directory) {
  let current = dirname(path);
  while (isWithin(current, directory) && resolve(current) !== resolve(directory)) {
    const metadata = await lstat(current).catch(() => null);
    if (metadata === null || metadata.isSymbolicLink() || !metadata.isDirectory()) {
      throw invalidEvidence();
    }
    await assertOwnerOnly(current, 0o700);
    current = dirname(current);
  }
}

async function validateBundleContents(directory, artifacts) {
  const allowedFiles = new Set([
    "evidence.json",
    "manifest.json",
    ...artifacts.map((artifact) => artifact.path)
  ]);
  const visit = async (current) => {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const entryPath = join(current, entry.name);
      const relativePath = relative(directory, entryPath);
      if (entry.isSymbolicLink()) {
        throw invalidEvidence();
      }
      if (entry.isDirectory()) {
        await assertOwnerOnly(entryPath, 0o700);
        await visit(entryPath);
        continue;
      }
      if (!entry.isFile() || !allowedFiles.has(relativePath)) {
        throw invalidEvidence();
      }
      await assertOwnerOnly(entryPath, 0o600);
    }
  };
  await visit(directory);
}

async function ensureDirectory(path, mode, parent, { chmodExisting = true } = {}) {
  if (!isWithin(path, parent) && resolve(path) !== resolve(parent)) {
    throw invalidEvidence();
  }
  const metadata = await lstat(path).catch(() => null);
  if (metadata?.isSymbolicLink() || metadata !== null && !metadata.isDirectory()) {
    throw invalidEvidence();
  }
  if (metadata === null) {
    await mkdir(path, { recursive: false, mode });
  }
  if (chmodExisting || metadata === null) {
    await chmod(path, mode);
  }
}

async function writeAtomicText(path, text, parentDirectory) {
  if (!isWithin(path, parentDirectory)) {
    throw invalidEvidence();
  }
  const existing = await lstat(path).catch(() => null);
  if (existing?.isSymbolicLink() || existing !== null && !existing.isFile()) {
    throw invalidEvidence();
  }
  const temporaryPath = join(parentDirectory, `.${path.split("/").at(-1)}.${cryptoRandomName()}.tmp`);
  let handle;
  try {
    handle = await open(temporaryPath, "wx", 0o600);
    await handle.writeFile(text, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await chmod(temporaryPath, 0o600);
    await rename(temporaryPath, path);
    await chmod(path, 0o600);
    await fsyncDirectory(parentDirectory);
    const readback = await readFile(path, "utf8");
    if (readback !== text) {
      throw invalidEvidence();
    }
  } catch (error) {
    if (handle !== undefined) {
      await handle.close().catch(() => {});
    }
    await rm(temporaryPath, { force: true }).catch(() => {});
    throw error;
  }
}

async function fsyncDirectory(path) {
  try {
    const handle = await open(path, "r");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  } catch {
    // Some filesystems do not expose directory fsync; file fsync and readback
    // validation still preserve the atomic replace contract there.
  }
}

async function assertOwnerOnly(path, expectedMode) {
  const metadata = await stat(path);
  if ((metadata.mode & 0o777) !== expectedMode) {
    throw invalidEvidence();
  }
}

function safeRelativePath(value) {
  if (typeof value !== "string" || value.length === 0 || value.length > 240
      || isAbsolute(value) || value.includes("\\") || hasControlCharacters(value)) {
    throw invalidEvidence();
  }
  const segments = value.split("/");
  if (segments.some((segment) => segment.length === 0 || segment === "." || segment === "..")) {
    throw invalidEvidence();
  }
  return value;
}

function assertArtifactPathSafe(value) {
  const path = safeRelativePath(value);
  if (UNSAFE_ARTIFACT_PATH_PATTERN.test(path)) {
    throw invalidEvidence();
  }
  return path;
}

function containsSecretLikeText(value) {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) {
    return true;
  }
  if (/\b(?:sk-(?:proj|admin|service|svcacct)-[A-Za-z0-9_-]{12,}|Bearer\s+[A-Za-z0-9._-]{16,})\b/.test(serialized)) {
    return true;
  }
  return Object.keys(value).some((key) => SENSITIVE_KEY_PATTERN.test(key));
}

function assertPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)
      || Object.getPrototypeOf(value) !== Object.prototype) {
    throw invalidEvidence();
  }
}

function assertExactKeys(value, expectedKeys) {
  const expected = new Set(expectedKeys);
  if (Object.keys(value).some((key) => !expected.has(key))) {
    throw invalidEvidence();
  }
  for (const key of expectedKeys) {
    if (!Object.hasOwn(value, key)) {
      throw invalidEvidence();
    }
  }
}

function assertAllowedKeys(value, allowedKeys, requiredKeys = []) {
  const allowed = new Set(allowedKeys);
  if (Object.keys(value).some((key) => !allowed.has(key))) {
    throw invalidEvidence();
  }
  for (const key of requiredKeys) {
    if (!Object.hasOwn(value, key)) {
      throw invalidEvidence();
    }
  }
}

function boundedText(value, max) {
  return typeof value === "string" && value.length > 0 && value.length <= max
    && !hasControlCharacters(value);
}

function hasControlCharacters(value) {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 0x20 || code === 0x7f) {
      return true;
    }
  }
  return false;
}

function boundedIdentifier(value) {
  return typeof value === "string" && IDENTIFIER_PATTERN.test(value);
}

function parseJson(value) {
  try {
    return JSON.parse(String(value).replace(/^\uFEFF/, ""));
  } catch {
    throw invalidEvidence();
  }
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function cryptoRandomName() {
  return randomUUID();
}

function requireAbsolute(value) {
  if (typeof value !== "string" || !isAbsolute(value)) {
    throw invalidEvidence();
  }
  return resolve(value);
}

function isWithin(candidate, parent) {
  const remainder = relative(resolve(parent), resolve(candidate));
  return remainder === "" || (remainder !== ".." && !remainder.startsWith("../"));
}

function invalidEvidence() {
  return safeError("INVALID_EVIDENCE", "Evidence is invalid.");
}

function safeError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}
