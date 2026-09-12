import { DEFAULT_BUDGETS } from "./budgets.mjs";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256_PATTERN = /^[a-f0-9]{64}$/i;
const UTC_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const INTERACTIVE_UTC_PATTERN = UTC_PATTERN;
const INTERACTIVE_OUTPUT_MAX_COUNT = 128;
const STATUS_VALUES = new Set(["PASS", "FAIL", "BLOCKED", "UNVERIFIED"]);
const SERVICE_STATE_VALUES = new Set(["ready", "started", "stopped"]);
const MAX_STATES = 32;
const MAX_COUNTS = 128;
const MAX_ERROR_COUNT = 16;

export const DESKTOP_AUTOMATION_ACTIONS = Object.freeze(["read-state", "click-test-id"]);

export const DESKTOP_AUTOMATION_TEST_IDS = Object.freeze({
  appStatus: "phase9b-app-status",
  realtimeStatus: "phase9b-realtime-status",
  remoteTrackCount: "phase9b-realtime-remote-track-count",
  conversationId: "phase9b-conversation-id",
  messageCount: "phase9b-message-count",
  taskCount: "phase9b-task-count",
  terminalTaskCount: "phase9b-terminal-task-count",
  terminalTaskId: "phase9b-terminal-task-id",
  terminalTaskStatus: "phase9b-terminal-task-status",
  artifactCount: "phase9b-artifact-count",
  artifactRestoreStatus: "phase9b-artifact-restore-status",
  notificationCount: "phase9b-notification-count",
  approvalCount: "phase9b-approval-count",
  deviceStatus: "phase9b-device-status",
  codexTaskStatus: "phase9b-codex-task-status",
  userInputStatus: "phase9b-user-input-status",
  approvalStatus: "phase9b-approval-status",
  signalrStatus: "phase9b-signalr-status",
  artifactSha256: "phase9b-artifact-sha256"
});

export const DESKTOP_AUTOMATION_ACTION_IDS = Object.freeze({
  connectRealtime: "phase9b-connect-realtime",
  disconnectRealtime: "phase9b-disconnect-realtime",
  sendFixture: "phase9b-send-fixture",
  pauseSignalr: "phase9b-pause-signalr",
  resumeSignalr: "phase9b-resume-signalr",
  loadConversation: "phase9b-load-conversation",
  answerInput: "phase9b-answer-input",
  approve: "phase9b-approve",
  deny: "phase9b-deny",
  restartDeviceNode: "phase9b-restart-device-node",
  quit: "phase9b-quit"
});

export const DESKTOP_AUTOMATION_SCENARIO_IDS = Object.freeze([
  "isolated-installation",
  "realtime",
  "delegated-responses",
  "restart-cancellation",
  "local-read-task",
  "user-input",
  "deny",
  "approve-once",
  "device-node-restart",
  "cold-start",
  "preflight",
  "security-remediation",
  "desktop-golden-path",
  "acceptance-matrix",
  "process-cleanup",
  "cleanup"
]);

const SCENARIO_IDS = new Set(DESKTOP_AUTOMATION_SCENARIO_IDS);

const TEST_ID_TYPES = new Map([
  [DESKTOP_AUTOMATION_TEST_IDS.appStatus, "enum"],
  [DESKTOP_AUTOMATION_TEST_IDS.realtimeStatus, "enum"],
  [DESKTOP_AUTOMATION_TEST_IDS.remoteTrackCount, "count"],
  [DESKTOP_AUTOMATION_TEST_IDS.conversationId, "uuid"],
  [DESKTOP_AUTOMATION_TEST_IDS.messageCount, "count"],
  [DESKTOP_AUTOMATION_TEST_IDS.taskCount, "count"],
  [DESKTOP_AUTOMATION_TEST_IDS.terminalTaskCount, "count"],
  [DESKTOP_AUTOMATION_TEST_IDS.terminalTaskId, "uuid"],
  [DESKTOP_AUTOMATION_TEST_IDS.terminalTaskStatus, "enum"],
  [DESKTOP_AUTOMATION_TEST_IDS.artifactCount, "count"],
  [DESKTOP_AUTOMATION_TEST_IDS.artifactRestoreStatus, "enum"],
  [DESKTOP_AUTOMATION_TEST_IDS.notificationCount, "count"],
  [DESKTOP_AUTOMATION_TEST_IDS.approvalCount, "count"],
  [DESKTOP_AUTOMATION_TEST_IDS.deviceStatus, "enum"],
  [DESKTOP_AUTOMATION_TEST_IDS.codexTaskStatus, "enum"],
  [DESKTOP_AUTOMATION_TEST_IDS.userInputStatus, "enum"],
  [DESKTOP_AUTOMATION_TEST_IDS.approvalStatus, "enum"],
  [DESKTOP_AUTOMATION_TEST_IDS.signalrStatus, "enum"],
  [DESKTOP_AUTOMATION_TEST_IDS.artifactSha256, "sha256"]
]);

const STATE_ENUMS = new Set([
  "approved",
  "answered",
  "available",
  "blocked",
  "catching-up",
  "connected",
  "connecting",
  "cancelled",
  "canceled",
  "completed",
  "complete",
  "denied",
  "disconnected",
  "ended",
  "ending",
  "error",
  "expired",
  "failed",
  "hidden",
  "loading",
  "muted",
  "offline",
  "online",
  "paused",
  "partial",
  "pending",
  "quitting",
  "ready",
  "reconnecting",
  "restored",
  "rotated",
  "rotating",
  "running",
  "restoring",
  "selected",
  "starting",
  "started",
  "stopping",
  "stopped",
  "succeeded",
  "unavailable",
  "unmuted"
]);

const COUNT_KEYS = new Set([
  "providerRequests",
  "realtimeConnections",
  "delegationAttempts",
  "codexTasks",
  "retries",
  "conversationCount",
  "unexpectedConversationCount",
  "eventCount",
  "executionCount",
  "messageCount",
  "taskCount",
  "notificationCount",
  "approvalCount",
  "remoteTrackCount",
  "realtimeConnectionCount",
  "delegationCount",
  "codexTaskCount",
  "retryCount"
]);

const ID_KEYS = new Set([
  "jarvisConversationId",
  "jarvisRealtimeSessionId",
  "jarvisTaskId",
  "jarvisExecutionId",
  "jarvisMessageId",
  "jarvisNotificationId",
  "jarvisApprovalId",
  "jarvisOutboxId",
  "deviceId",
  "realtimeSessionIdHash",
  "responseIdHash",
  "codexTaskIdHash",
  "codexThreadIdHash",
  "codexTurnIdHash",
  "requestIdHash"
]);

const BOOLEAN_KEYS = new Set([
  "audioMuted",
  "conversationRestored",
  "sameConversation",
  "sameTask",
  "sameExecution",
  "sameThread",
  "sideEffectFree",
  "watchdogUsed",
  "cleaned",
  "signalrPaused",
  "duplicateFree",
  "terminal",
  "automaticRefresh",
  "selectionRestored",
  "noExtraConversation",
  "noOrphanConnectedSession",
  "messageSequenceContinues",
  "oldSessionRotated",
  "newSessionConnected",
  "normalQuitCompleted",
  "shutdownAcknowledged",
  "fallbackUsed",
  "requestReissued",
  "continuationUsed",
  "answerConsumed",
  "fixtureUnchanged",
  "canaryUnchanged"
]);

const HASH_KEYS = new Set([
  "artifactSha256",
  "externalIdSha256",
  "oldSessionIdSha256",
  "newSessionIdSha256",
  "codexTaskIdSha256",
  "codexThreadIdSha256",
  "codexTurnIdSha256",
  "requestIdSha256"
]);

const ERROR_CODES = new Set([
  "AUTOMATION_DRIVER_FAILED",
  "BLOCKED_CODEX_AUTH",
  "BLOCKED_PROVIDER_ACCESS",
  "BLOCKED_SECURITY_REMEDIATION",
  "BUDGET_EXHAUSTED",
  "CLEANUP_FAILED",
  "INVALID_AUTOMATION_COMMAND",
  "INVALID_AUTOMATION_OUTPUT",
  "INVALID_COMMAND",
  "INVALID_COMMAND_STATE",
  "OBSERVATION_INVALID",
  "OUTPUT_REJECTED",
  "PROCESS_ERROR",
  "PROCESS_START_FAILED",
  "SCENARIO_DRIVER_FAILED",
  "SCENARIO_DRIVER_UNAVAILABLE",
  "SECRET_DETECTED",
  "SERVICE_UNREADY",
  "TIMEOUT",
  "UNVERIFIED",
  "VALIDATION_FAILED"
]);

const INTERACTIVE_STATUS_VALUES = new Set([
  ...STATUS_VALUES,
  "PREPARED",
  "STARTED",
  "OBSERVED",
  "STOPPED",
  "RESTARTED",
  "FINISHED",
  "LIVE_PARTIAL",
  "LIVE_BUDGET_EXHAUSTED",
  "BLOCKED_CREDENTIALS",
  "BLOCKED_TOOLCHAIN",
  "BLOCKED_PROVIDER_CONFIG",
  "BLOCKED_PROVIDER_ACCESS",
  "BLOCKED_CODEX_AUTH",
  "BLOCKED_SECURITY_REMEDIATION"
]);
const INTERACTIVE_ERROR_CODES = new Set([
  ...ERROR_CODES,
  "API_BINARY_UNAVAILABLE",
  "ADMISSION_UNAVAILABLE",
  "ADMISSION_INTEGRITY",
  "ADMISSION_INVALID",
  "ADMISSION_OWNERSHIP_INVALID",
  "ADMISSION_RESTART_UNSAFE",
  "API_OBSERVATION_FAILED",
  "API_UNAUTHORIZED",
  "CODEX_BINARY_UNAVAILABLE",
  "CODEX_BINARY_UNSAFE",
  "CODEX_HOME_ADOPTION_FAILED",
  "CODEX_PATH_REQUIRED",
  "DESKTOP_BINARY_UNAVAILABLE",
  "DEVICE_NODE_BINARY_UNAVAILABLE",
  "INTERRUPTED",
  "INTERACTIVE_RUN_FAILED",
  "INVALID_PROVIDER_CONFIG",
  "INVALID_RUN_ID",
  "LAUNCHD_BOOTSTRAP_FAILED",
  "LAUNCHD_CLEANUP_FAILED",
  "LAUNCHD_CWD_INVALID",
  "LAUNCHD_EXECUTABLE_INVALID",
  "LAUNCHD_LABEL_INVALID",
  "LAUNCHD_OPERATION_FAILED",
  "LAUNCHD_OWNERSHIP_INVALID",
  "LAUNCHD_PLIST_INVALID",
  "LAUNCHD_SERVICE_INVALID",
  "LAUNCHD_SERVICE_UNREADY",
  "LAUNCHD_UNAVAILABLE",
  "OBSERVATION_INVALID",
  "OUTPUT_REJECTED",
  "OWNERSHIP_MARKER_INVALID",
  "PORT_ALLOCATION_FAILED",
  "PRIVATE_FILE_INTEGRITY",
  "SERVICE_UNREADY",
  "UNSAFE_CODEX_HOME",
  "UNSAFE_PRIVATE_PATH",
  "UNSAFE_PROCESS_ARGUMENTS",
  "UNSAFE_PROCESS_CWD",
  "UNSAFE_PROCESS_ENVIRONMENT",
  "UNSAFE_TEMP_ROOT",
  "UNSAFE_TEMP_ROOT_SYMLINK"
]);
const INTERACTIVE_BUDGET_KEYS = Object.freeze([
  "providerRequests",
  "realtimeConnections",
  "delegationAttempts",
  "codexTasks",
  "retries"
]);
const INTERACTIVE_OUTPUT_KEYS = Object.freeze([
  "schemaVersion",
  "status",
  "runId",
  "preflight",
  "credentials",
  "budgets",
  "installation",
  "services",
  "service",
  "desktopBearerSource",
  "budgetGuard",
  "api",
  "device",
  "conversation",
  "facts",
  "securityRemediation",
  "errorCategory",
  "cleanupErrorCategory",
  "cleaned",
  "removed",
  "startedAtUtc",
  "finishedAtUtc",
  "updatedAtUtc",
  "timestamp"
]);

export function parseDesktopAutomationCommand(value) {
  assertPlainObject(value, "INVALID_AUTOMATION_COMMAND");
  if (typeof value.action !== "string" || !DESKTOP_AUTOMATION_ACTIONS.includes(value.action)) {
    throw automationError("INVALID_AUTOMATION_COMMAND");
  }
  if (value.action === "read-state") {
    assertAllowedKeys(value, ["action", "testIds"], "INVALID_AUTOMATION_COMMAND");
    if (value.testIds === undefined) {
      return { action: value.action, testIds: [...TEST_ID_TYPES.keys()] };
    }
    if (!Array.isArray(value.testIds) || value.testIds.length === 0 || value.testIds.length > MAX_STATES
        || value.testIds.some((testId) => typeof testId !== "string" || !TEST_ID_TYPES.has(testId))) {
      throw automationError("INVALID_AUTOMATION_COMMAND");
    }
    return { action: value.action, testIds: [...value.testIds] };
  }
  assertExactKeys(value, ["action", "testId"], "INVALID_AUTOMATION_COMMAND");
  if (!Object.values(DESKTOP_AUTOMATION_ACTION_IDS).includes(value.testId)) {
    throw automationError("INVALID_AUTOMATION_COMMAND");
  }
  return { action: value.action, testId: value.testId };
}

export function createDesktopAutomationDriver({ page } = {}) {
  if (page === null || typeof page !== "object"
      || typeof page.readTestId !== "function"
      || typeof page.clickTestId !== "function") {
    throw automationError("INVALID_AUTOMATION_DRIVER");
  }
  return Object.freeze({
    async run(command) {
      const safeCommand = parseDesktopAutomationCommand(command);
      try {
        if (safeCommand.action === "click-test-id") {
          await page.clickTestId(safeCommand.testId);
          return { status: "PASS" };
        }
        const states = [];
        for (const testId of safeCommand.testIds) {
          states.push({ testId, value: await page.readTestId(testId) });
        }
        return sanitizeDesktopAutomationOutput({ status: "PASS", states });
      } catch (error) {
        if (error?.code === "INVALID_AUTOMATION_OUTPUT") {
          throw error;
        }
        throw sanitizeDesktopAutomationError(error);
      }
    }
  });
}

export function sanitizeDesktopAutomationOutput(value) {
  assertPlainObject(value, "INVALID_AUTOMATION_OUTPUT");
  assertAllowedKeys(value, ["status", "states", "counts", "ids", "booleans", "errors", "hashes"], "INVALID_AUTOMATION_OUTPUT");
  const result = {};
  if (value.status !== undefined) {
    if (!STATUS_VALUES.has(value.status)) {
      throw automationError("INVALID_AUTOMATION_OUTPUT");
    }
    result.status = value.status;
  }
  if (value.states !== undefined) {
    if (!Array.isArray(value.states) || value.states.length > MAX_STATES) {
      throw automationError("INVALID_AUTOMATION_OUTPUT");
    }
    result.states = value.states.map((state) => sanitizeState(state));
  }
  if (value.counts !== undefined) {
    result.counts = sanitizeCounts(value.counts);
  }
  if (value.ids !== undefined) {
    result.ids = sanitizeIds(value.ids);
  }
  if (value.booleans !== undefined) {
    result.booleans = sanitizeBooleans(value.booleans);
  }
  if (value.errors !== undefined) {
    result.errors = sanitizeErrors(value.errors);
  }
  if (value.hashes !== undefined) {
    result.hashes = sanitizeHashes(value.hashes);
  }
  if (Object.keys(result).length === 0) {
    throw automationError("INVALID_AUTOMATION_OUTPUT");
  }
  return result;
}

export function sanitizeDesktopScenarioResult(value) {
  assertPlainObject(value, "INVALID_AUTOMATION_OUTPUT");
  assertAllowedKeys(value, ["scenarios", "automation"], "INVALID_AUTOMATION_OUTPUT");
  if (!Array.isArray(value.scenarios) || value.scenarios.length === 0 || value.scenarios.length > MAX_STATES) {
    throw automationError("INVALID_AUTOMATION_OUTPUT");
  }
  const result = { scenarios: value.scenarios.map((scenario) => sanitizeScenario(scenario)) };
  if (value.automation !== undefined) {
    result.automation = sanitizeDesktopAutomationOutput(value.automation);
  }
  return result;
}

export function createSafeScenarioDriver(driver) {
  if (typeof driver !== "function") {
    throw automationError("INVALID_AUTOMATION_DRIVER");
  }
  return async (context) => {
    let result;
    try {
      result = await driver(context);
    } catch (error) {
      throw sanitizeDesktopAutomationError(error);
    }
    try {
      return sanitizeDesktopScenarioResult(result);
    } catch (error) {
      if (error?.code === "INVALID_AUTOMATION_OUTPUT") {
        throw error;
      }
      throw sanitizeDesktopAutomationError(error);
    }
  };
}

export function sanitizeInteractiveOutput(value) {
  try {
    return projectInteractiveResult(value);
  } catch (error) {
    if (error?.code === "OUTPUT_REJECTED") {
      throw error;
    }
    throw automationError("OUTPUT_REJECTED");
  }
}

export function sanitizeDesktopAutomationError(error) {
  const code = ERROR_CODES.has(error?.code) ? error.code : "AUTOMATION_DRIVER_FAILED";
  const sanitized = new Error("Desktop automation failed.");
  sanitized.code = code;
  return sanitized;
}

function sanitizeState(value) {
  assertPlainObject(value, "INVALID_AUTOMATION_OUTPUT");
  assertExactKeys(value, ["testId", "value"], "INVALID_AUTOMATION_OUTPUT");
  const type = TEST_ID_TYPES.get(value.testId);
  if (type === undefined) {
    throw automationError("INVALID_AUTOMATION_OUTPUT");
  }
  if (type === "enum" && (typeof value.value !== "string" || !STATE_ENUMS.has(value.value))) {
    throw automationError("INVALID_AUTOMATION_OUTPUT");
  }
  if (type === "count" && !isBoundedCount(value.value)) {
    throw automationError("INVALID_AUTOMATION_OUTPUT");
  }
  if (type === "uuid" && !UUID_PATTERN.test(value.value ?? "")) {
    throw automationError("INVALID_AUTOMATION_OUTPUT");
  }
  if (type === "sha256" && !SHA256_PATTERN.test(value.value ?? "")) {
    throw automationError("INVALID_AUTOMATION_OUTPUT");
  }
  return { testId: value.testId, value: value.value };
}

function sanitizeCounts(value) {
  return sanitizeRecord(value, COUNT_KEYS, (amount) => isBoundedCount(amount));
}

function sanitizeIds(value) {
  return sanitizeRecord(value, ID_KEYS, (id, key) => key.endsWith("Hash") ? SHA256_PATTERN.test(id ?? "") : UUID_PATTERN.test(id ?? ""));
}

function sanitizeBooleans(value) {
  return sanitizeRecord(value, BOOLEAN_KEYS, (item) => typeof item === "boolean");
}

function sanitizeHashes(value) {
  return sanitizeRecord(value, HASH_KEYS, (hash) => SHA256_PATTERN.test(hash ?? ""));
}

function sanitizeRecord(value, allowedKeys, isValid) {
  assertPlainObject(value, "INVALID_AUTOMATION_OUTPUT");
  const result = {};
  for (const [key, item] of Object.entries(value)) {
    if (!allowedKeys.has(key) || !isValid(item, key)) {
      throw automationError("INVALID_AUTOMATION_OUTPUT");
    }
    result[key] = item;
  }
  return result;
}

function sanitizeErrors(value) {
  if (!Array.isArray(value) || value.length > MAX_ERROR_COUNT) {
    throw automationError("INVALID_AUTOMATION_OUTPUT");
  }
  return value.map((item) => {
    assertPlainObject(item, "INVALID_AUTOMATION_OUTPUT");
    assertExactKeys(item, ["code"], "INVALID_AUTOMATION_OUTPUT");
    if (!ERROR_CODES.has(item.code)) {
      throw automationError("INVALID_AUTOMATION_OUTPUT");
    }
    return { code: item.code };
  });
}

function sanitizeScenario(value) {
  assertPlainObject(value, "INVALID_AUTOMATION_OUTPUT");
  assertAllowedKeys(value, [
    "id",
    "status",
    "startedAtUtc",
    "finishedAtUtc",
    "durationMs",
    "errorCategory",
    "counts",
    "ids",
    "artifactPaths"
  ], "INVALID_AUTOMATION_OUTPUT");
  if (!SCENARIO_IDS.has(value.id)
      || !STATUS_VALUES.has(value.status)
      || !UTC_PATTERN.test(value.startedAtUtc ?? "")
      || !UTC_PATTERN.test(value.finishedAtUtc ?? "")
      || !Number.isSafeInteger(value.durationMs)
      || value.durationMs < 0
      || value.durationMs > 10 * 60 * 1000
      || Date.parse(value.finishedAtUtc) < Date.parse(value.startedAtUtc)) {
    throw automationError("INVALID_AUTOMATION_OUTPUT");
  }
  const result = {
    id: value.id,
    status: value.status,
    startedAtUtc: value.startedAtUtc,
    finishedAtUtc: value.finishedAtUtc,
    durationMs: value.durationMs
  };
  if (value.errorCategory !== undefined) {
    if (!ERROR_CODES.has(value.errorCategory)) {
      throw automationError("INVALID_AUTOMATION_OUTPUT");
    }
    result.errorCategory = value.errorCategory;
  }
  if (value.counts !== undefined) {
    result.counts = sanitizeCounts(value.counts);
  }
  if (value.ids !== undefined) {
    result.ids = sanitizeIds(value.ids);
  }
  if (value.artifactPaths !== undefined) {
    if (!Array.isArray(value.artifactPaths) || value.artifactPaths.length > MAX_STATES) {
      throw automationError("INVALID_AUTOMATION_OUTPUT");
    }
    result.artifactPaths = value.artifactPaths.map((path) => safeRelativeArtifactPath(path));
  }
  return result;
}

function safeRelativeArtifactPath(value) {
  if (typeof value !== "string" || value.length === 0 || value.length > 240
      || value.startsWith("/") || value.includes("\\") || /(?:^|\/)\.\.?(?:\/|$)/.test(value)
      || /(?:database|audio|credential|environment|fixture|header|innerhtml|keychain|oauth|prompt|screenshot|token|transcript|provider|response|request|body|payload)/i.test(value)) {
    throw automationError("INVALID_AUTOMATION_OUTPUT");
  }
  return value;
}

function projectInteractiveResult(value) {
  assertPlainObject(value, "OUTPUT_REJECTED");
  assertExactKeys(
    value,
    ["schemaVersion", "status"],
    "OUTPUT_REJECTED",
    INTERACTIVE_OUTPUT_KEYS.filter((key) => key !== "schemaVersion" && key !== "status")
  );
  if (value.schemaVersion !== 1 || !INTERACTIVE_STATUS_VALUES.has(value.status)) {
    throw automationError("OUTPUT_REJECTED");
  }
  const result = { schemaVersion: 1, status: value.status };
  if (value.runId !== undefined) {
    result.runId = projectNullableInternalUuid(value.runId);
  }
  if (value.preflight !== undefined) {
    result.preflight = projectPreflight(value.preflight);
  }
  if (value.credentials !== undefined) {
    result.credentials = projectCredentials(value.credentials);
  }
  if (value.budgets !== undefined) {
    result.budgets = value.budgets === null ? null : projectBudgetSnapshot(value.budgets);
  }
  if (value.installation !== undefined) {
    result.installation = projectInstallation(value.installation);
  }
  if (value.services !== undefined) {
    result.services = projectServices(value.services);
  }
  if (value.service !== undefined) {
    if (!(typeof value.service === "string" && ["api", "deviceNode", "desktop"].includes(value.service))) {
      throw automationError("OUTPUT_REJECTED");
    }
    result.service = value.service;
  }
  if (value.desktopBearerSource !== undefined) {
    if (value.desktopBearerSource !== "encrypted-store") {
      throw automationError("OUTPUT_REJECTED");
    }
    result.desktopBearerSource = value.desktopBearerSource;
  }
  if (value.budgetGuard !== undefined) {
    result.budgetGuard = projectBudgetGuard(value.budgetGuard);
  }
  if (value.api !== undefined) {
    result.api = projectApi(value.api);
  }
  if (value.device !== undefined) {
    result.device = projectDevice(value.device);
  }
  if (value.conversation !== undefined) {
    result.conversation = projectConversation(value.conversation);
  }
  if (value.facts !== undefined) {
    result.facts = projectFacts(value.facts);
  }
  if (value.securityRemediation !== undefined) {
    assertExactKeys(value.securityRemediation, ["status"], "OUTPUT_REJECTED");
    if (!["UNVERIFIED", "RESOLVED_NO_REUSABLE_CREDENTIAL_EXPOSURE", "BLOCKED_SECURITY_REMEDIATION"]
      .includes(value.securityRemediation.status)) {
      throw automationError("OUTPUT_REJECTED");
    }
    result.securityRemediation = { status: value.securityRemediation.status };
  }
  if (value.errorCategory !== undefined) {
    result.errorCategory = projectErrorCode(value.errorCategory);
  }
  if (value.cleanupErrorCategory !== undefined) {
    result.cleanupErrorCategory = projectErrorCode(value.cleanupErrorCategory);
  }
  for (const key of ["cleaned", "removed"]) {
    if (value[key] !== undefined) {
      if (typeof value[key] !== "boolean") {
        throw automationError("OUTPUT_REJECTED");
      }
      result[key] = value[key];
    }
  }
  for (const key of ["startedAtUtc", "finishedAtUtc", "updatedAtUtc", "timestamp"]) {
    if (value[key] !== undefined) {
      result[key] = projectTimestamp(value[key]);
    }
  }
  return result;
}

function projectPreflight(value) {
  assertExactKeys(value, ["status", "providerCalls"], "OUTPUT_REJECTED");
  return {
    status: projectInteractiveStatus(value.status),
    providerCalls: projectCount(value.providerCalls, 12)
  };
}

function projectCredentials(value) {
  assertExactKeys(value, ["status", "presence"], "OUTPUT_REJECTED");
  assertExactKeys(value.presence, ["userSecretsFound", "openAiApiKey", "deepSeekApiKey"], "OUTPUT_REJECTED");
  return {
    status: projectInteractiveStatus(value.status),
    presence: {
      userSecretsFound: projectBoolean(value.presence.userSecretsFound),
      openAiApiKey: projectBoolean(value.presence.openAiApiKey),
      deepSeekApiKey: projectBoolean(value.presence.deepSeekApiKey)
    }
  };
}

function projectBudgetSnapshot(value) {
  assertExactKeys(value, ["limits", "used", "remaining"], "OUTPUT_REJECTED");
  const limits = projectBudgetValues(value.limits);
  const used = projectBudgetValues(value.used);
  const remaining = projectBudgetValues(value.remaining);
  for (const key of INTERACTIVE_BUDGET_KEYS) {
    if (used[key] > limits[key] || remaining[key] > limits[key] || used[key] + remaining[key] !== limits[key]) {
      throw automationError("OUTPUT_REJECTED");
    }
  }
  return { limits, used, remaining };
}

function projectBudgetValues(value) {
  assertPlainObject(value, "OUTPUT_REJECTED");
  assertExactKeys(value, INTERACTIVE_BUDGET_KEYS, "OUTPUT_REJECTED");
  const result = {};
  for (const key of INTERACTIVE_BUDGET_KEYS) {
    result[key] = projectCount(value[key], 12);
    if (result[key] > DEFAULT_BUDGET_LIMITS[key]) {
      throw automationError("OUTPUT_REJECTED");
    }
  }
  return result;
}

const DEFAULT_BUDGET_LIMITS = DEFAULT_BUDGETS;

function projectInstallation(value) {
  assertExactKeys(value, ["mode", "status"], "OUTPUT_REJECTED", ["reason", "labelsConfigured"]);
  if (![
    "direct-owned-processes",
    "launchd-api-device-owned-desktop"
  ].includes(value.mode) || !["PASS", "UNVERIFIED"].includes(value.status)) {
    throw automationError("OUTPUT_REJECTED");
  }
  const result = { mode: value.mode, status: value.status };
  if (value.reason !== undefined) {
    if (value.reason !== "LAUNCHD_NOT_WIRED") {
      throw automationError("OUTPUT_REJECTED");
    }
    result.reason = value.reason;
  }
  if (value.labelsConfigured !== undefined) {
    result.labelsConfigured = projectBoolean(value.labelsConfigured);
  }
  return result;
}

function projectServices(value) {
  assertExactKeys(value, ["api", "deviceNode", "desktop"], "OUTPUT_REJECTED");
  return {
    api: projectServiceState(value.api),
    deviceNode: projectServiceState(value.deviceNode),
    desktop: projectServiceState(value.desktop)
  };
}

function projectServiceState(value) {
  if (typeof value !== "string" || !SERVICE_STATE_VALUES.has(value)) {
    throw automationError("OUTPUT_REJECTED");
  }
  return value;
}

function projectBudgetGuard(value) {
  assertExactKeys(value, [
    "status",
    "startupProviderRequests",
    "startupRealtimeConnections",
    "observation",
    "pollMs"
  ], "OUTPUT_REJECTED");
  if (value.status !== "ARMED" || value.observation !== "sqlite-runtime-poll") {
    throw automationError("OUTPUT_REJECTED");
  }
  if (!Number.isSafeInteger(value.pollMs) || value.pollMs < 100 || value.pollMs > 10_000) {
    throw automationError("OUTPUT_REJECTED");
  }
  return {
    status: value.status,
    startupProviderRequests: projectCount(value.startupProviderRequests, 12),
    startupRealtimeConnections: projectCount(value.startupRealtimeConnections, 4),
    observation: value.observation,
    pollMs: value.pollMs
  };
}

function projectApi(value) {
  assertExactKeys(value, ["live", "ready", "database"], "OUTPUT_REJECTED");
  return {
    live: projectBoolean(value.live),
    ready: projectBoolean(value.ready),
    database: projectBoolean(value.database)
  };
}

function projectDevice(value) {
  assertExactKeys(value, ["registered", "online"], "OUTPUT_REJECTED");
  return {
    registered: projectBoolean(value.registered),
    online: projectCount(value.online, INTERACTIVE_OUTPUT_MAX_COUNT)
  };
}

function projectConversation(value) {
  assertExactKeys(value, ["id", "messageCount"], "OUTPUT_REJECTED");
  return {
    id: projectInternalUuid(value.id),
    messageCount: projectCount(value.messageCount, INTERACTIVE_OUTPUT_MAX_COUNT)
  };
}

function projectFacts(value) {
  const countKeys = [
    "realtimeSecretsIssued",
    "realtimeSessions",
    "realtimeConnections",
    "responseRequests",
    "responseExecutions",
    "responseTasks",
    "delegationAttemptsObserved",
    "codexTaskExecutions",
    "codexExecutions",
    "codexTasks",
    "codexStartedTasks"
  ];
  assertExactKeys(value, [...countKeys, "sources", "budgetObservation"], "OUTPUT_REJECTED");
  const result = {};
  for (const key of countKeys) {
    result[key] = projectCount(value[key], INTERACTIVE_OUTPUT_MAX_COUNT);
  }
  result.sources = projectSources(value.sources);
  result.budgetObservation = projectBudgetObservation(value.budgetObservation);
  return result;
}

function projectSources(value) {
  const sources = {
    realtimeSecretsIssued: "sqlite:RealtimeSessions.rows",
    realtimeConnections: "sqlite:RealtimeSessions.ConnectedAtMs",
    responseRequests: "sqlite:TaskExecutions.Responses.ExternalExecutionId",
    responseTasks: "sqlite:Tasks.WorkerKind.Responses",
    delegationAttemptsObserved: "sqlite:ResponsesTasks.join.RealtimeMessages",
    codexTasks: "sqlite:Tasks.WorkerKind.Codex",
    codexStartedTasks: "sqlite:TaskExecutions.CodexThreadId.distinctTaskId"
  };
  assertExactKeys(value, Object.keys(sources), "OUTPUT_REJECTED");
  for (const [key, expected] of Object.entries(sources)) {
    if (value[key] !== expected) {
      throw automationError("OUTPUT_REJECTED");
    }
  }
  return { ...sources };
}

function projectBudgetObservation(value) {
  assertExactKeys(value, ["status", "observed", "reserved"], "OUTPUT_REJECTED");
  if (value.status !== "PASS") {
    throw automationError("OUTPUT_REJECTED");
  }
  const observed = projectBudgetValues(value.observed);
  assertExactKeys(value.reserved, ["limits", "used"], "OUTPUT_REJECTED");
  const limits = projectBudgetValues(value.reserved.limits);
  const used = projectBudgetValues(value.reserved.used);
  for (const key of INTERACTIVE_BUDGET_KEYS) {
    if (used[key] > limits[key] || observed[key] > used[key]) {
      throw automationError("OUTPUT_REJECTED");
    }
  }
  return { status: value.status, observed, reserved: { limits, used } };
}

function projectInteractiveStatus(value) {
  if (!INTERACTIVE_STATUS_VALUES.has(value)) {
    throw automationError("OUTPUT_REJECTED");
  }
  return value;
}

function projectErrorCode(value) {
  if (!INTERACTIVE_ERROR_CODES.has(value)) {
    throw automationError("OUTPUT_REJECTED");
  }
  return value;
}

function projectBoolean(value) {
  if (typeof value !== "boolean") {
    throw automationError("OUTPUT_REJECTED");
  }
  return value;
}

function projectCount(value, max) {
  if (!Number.isSafeInteger(value) || value < 0 || value > max) {
    throw automationError("OUTPUT_REJECTED");
  }
  return value;
}

function projectNullableInternalUuid(value) {
  if (value === null) {
    return null;
  }
  return projectInternalUuid(value);
}

function projectInternalUuid(value) {
  if (!UUID_PATTERN.test(value ?? "")) {
    throw automationError("OUTPUT_REJECTED");
  }
  return value;
}

function projectTimestamp(value) {
  if (typeof value === "string") {
    if (!INTERACTIVE_UTC_PATTERN.test(value)) {
      throw automationError("OUTPUT_REJECTED");
    }
    return value;
  }
  if (!Number.isSafeInteger(value) || value < 0) {
    throw automationError("OUTPUT_REJECTED");
  }
  return value;
}

function isBoundedCount(value) {
  return Number.isSafeInteger(value) && value >= 0 && value <= MAX_COUNTS;
}

function assertPlainObject(value, code) {
  if (value === null || typeof value !== "object" || Array.isArray(value)
      || Object.getPrototypeOf(value) !== Object.prototype) {
    throw automationError(code);
  }
}

function assertExactKeys(value, expectedKeys, code, optionalKeys = []) {
  const allowed = new Set([...expectedKeys, ...optionalKeys]);
  if (Object.keys(value).some((key) => !allowed.has(key))) {
    throw automationError(code);
  }
  for (const key of expectedKeys) {
    if (!Object.hasOwn(value, key)) {
      throw automationError(code);
    }
  }
}

function assertAllowedKeys(value, allowedKeys, code) {
  const allowed = new Set(allowedKeys);
  if (Object.keys(value).some((key) => !allowed.has(key))) {
    throw automationError(code);
  }
}

function automationError(code) {
  const error = new Error(code === "OUTPUT_REJECTED" ? "Live output was rejected." : "Desktop automation boundary rejected the value.");
  error.code = code;
  return error;
}
