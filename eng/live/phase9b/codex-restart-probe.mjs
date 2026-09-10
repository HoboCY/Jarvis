import { createHash, randomUUID } from "node:crypto";
import { spawn as nodeSpawn } from "node:child_process";
import { open, chmod, lstat } from "node:fs/promises";
import { constants as fsConstants, createReadStream } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const CODEX_APP_SERVER_METHODS = Object.freeze({
  initialize: "initialize",
  initialized: "initialized",
  threadStart: "thread/start",
  threadResume: "thread/resume",
  threadRead: "thread/read",
  turnStart: "turn/start",
  turnCompleted: "turn/completed",
  serverRequestResolved: "serverRequest/resolved",
  requestUserInput: "item/tool/requestUserInput",
  commandApproval: "item/commandExecution/requestApproval",
  fileApproval: "item/fileChange/requestApproval",
  permissionApproval: "item/permissions/requestApproval",
  reasoningSummaryPartAdded: "item/reasoning/summaryPartAdded",
  reasoningTextDelta: "item/reasoning/textDelta",
  tokenUsageUpdated: "thread/tokenUsage/updated",
  accountRateLimitsUpdated: "account/rateLimits/updated"
});

export const PINNED_CODEX = Object.freeze({
  version: "0.146.0",
  sha256: "ae1d3ffe6d48aec6a4dc3f50e7eb8e0d11962485a6a9406c5a7012139383da02"
});

export const PROBE_LIMITS = Object.freeze({
  task: 1,
  restart: 1,
  answer: 1,
  continuation: 1
});

export const RECOVERY_MODES = Object.freeze({
  REISSUED_REQUEST: "REISSUED_REQUEST",
  SAFE_CONTINUATION: "SAFE_CONTINUATION",
  NOT_RESUMABLE: "NOT_RESUMABLE"
});

export const PROBE_ERROR_CODES = Object.freeze({
  OUTPUT_REJECTED: "OUTPUT_REJECTED",
  BUDGET_EXHAUSTED: "BUDGET_EXHAUSTED",
  INVALID_ENVIRONMENT: "INVALID_ENVIRONMENT",
  INVALID_PERMISSION_PROFILE: "INVALID_PERMISSION_PROFILE",
  INVALID_REQUEST: "INVALID_REQUEST",
  DUPLICATE_SERVER_REQUEST: "DUPLICATE_SERVER_REQUEST",
  STALE_REQUEST: "STALE_REQUEST",
  UNSEEN_REQUEST: "UNSEEN_REQUEST",
  REISSUED_REQUEST_MISMATCH: "REISSUED_REQUEST_MISMATCH",
  SECRET_INPUT_REJECTED: "SECRET_INPUT_REJECTED",
  EFFECTFUL_REQUEST_REJECTED: "EFFECTFUL_REQUEST_REJECTED",
  UNSUPPORTED_REQUEST: "UNSUPPORTED_REQUEST",
  ANSWER_ALREADY_CONSUMED: "ANSWER_ALREADY_CONSUMED",
  REQUEST_ALREADY_RESOLVED: "REQUEST_ALREADY_RESOLVED",
  ANSWER_INVALID: "ANSWER_INVALID",
  LEASE_LOST: "LEASE_LOST",
  CANCELLED: "CANCELLED",
  CODEX_PENDING_INTERACTION_NOT_RESUMABLE: "CODEX_PENDING_INTERACTION_NOT_RESUMABLE",
  PROBE_RUNTIME_ERROR: "PROBE_RUNTIME_ERROR",
  PROTOCOL_INVALID: "PROTOCOL_INVALID",
  PROTOCOL_TIMEOUT: "PROTOCOL_TIMEOUT",
  AUTH_METADATA_INVALID: "AUTH_METADATA_INVALID",
  PROBE_ALREADY_CONSUMED: "PROBE_ALREADY_CONSUMED",
  PINNED_BINARY_MISMATCH: "PINNED_BINARY_MISMATCH",
  PROCESS_CLEANUP_FAILED: "PROCESS_CLEANUP_FAILED",
  DEADLINE_EXCEEDED: "DEADLINE_EXCEEDED",
  PERMISSION_PROFILE_UNCONFIRMED: "PERMISSION_PROFILE_UNCONFIRMED"
  ,SECURITY_GATE_REQUIRED: "SECURITY_GATE_REQUIRED"
  ,OFFLINE_GATES_REQUIRED: "OFFLINE_GATES_REQUIRED"
});

const STATUS_VALUES = new Set([
  "PASS",
  "FAIL",
  "UNVERIFIED",
  "BLOCKED_CODEX_PROTOCOL_LIMITATION",
  "BLOCKED_SECURITY_REMEDIATION",
  "CANCELLED"
]);
const ERROR_VALUES = new Set(Object.values(PROBE_ERROR_CODES));
const MODE_VALUES = new Set(Object.values(RECOVERY_MODES));
const REQUEST_METHOD_VALUES = new Set([CODEX_APP_SERVER_METHODS.requestUserInput]);
const HISTORY_STATUS_VALUES = new Set(["inProgress", "completed", "failed", "interrupted", "pending"]);
const NATIVE_TURN_STATUS_VALUES = new Set(["inProgress", "completed", "failed", "interrupted"]);
const INTERNAL_UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const MAX_COUNT = 64;
const MAX_QUESTIONS = 3;
const MAX_OPTIONS = 20;
const MAX_ID_LENGTH = 500;
const MAX_TEXT_LENGTH = 4_000;
const MAX_ANSWER_LENGTH = 4_000;
const MAX_TOTAL_ANSWER_LENGTH = 20_000;
const MAX_RPC_LINE_BYTES = 128 * 1024;
const MAX_CAPTURE_BYTES = 256 * 1024;
const MAX_AUTH_METADATA_BYTES = 16 * 1024;
const MAX_AUTH_FILE_BYTES = 64 * 1024;
const PROBE_DURATION_MS = 8 * 60 * 1000;
const DECISION_WINDOW_MS = 10_000;
const DECISION_SCHEDULING_MARGIN_MS = 250;
const DECISION_WAIT_WINDOW_MS = DECISION_WINDOW_MS - DECISION_SCHEDULING_MARGIN_MS;
const PROCESS_KILL_GRACE_MS = 500;
const MAX_RECOVERY_DURATION_MS = DECISION_WINDOW_MS;
const MAX_AUTH_RESOLUTION_MS = 86_400_000;
const MAX_PROTOCOL_EVENTS = 64;
const PROBE_PHASE_VALUES = new Set([
  "gate",
  "auth",
  "pinned",
  "claim",
  "first-spawn",
  "first-initialize",
  "thread-start",
  "turn-start",
  "await-input",
  "bind-input",
  "first-stop",
  "restart",
  "recovery-spawn",
  "recovery-initialize",
  "resume",
  "read",
  "decision",
  "answer",
  "continuation",
  "completion",
  "cleanup"
]);
const TURN_COMPLETION_STATUS_VALUES = new Set(["completed", "failed", "interrupted", "unknown"]);
const AUTH_METADATA_KEYS = Object.freeze([
  "schemaVersion",
  "runId",
  "codexHome",
  "runtimeRoot",
  "allowedRoot",
  "authenticationCompleted",
  "credentialStore",
  "previousRuntimeReused"
]);
const SAFE_HISTORY_ITEM_TYPES = new Set([
  "userMessage",
  "agentMessage",
  "plan",
  "reasoning",
  "sleep",
  "contextCompaction"
]);
const EFFECTFUL_HISTORY_ITEM_TYPES = new Set([
  "commandExecution",
  "fileChange",
  "mcpToolCall",
  "dynamicToolCall",
  "webSearch",
  "imageView",
  "imageGeneration",
  "collabAgentToolCall",
  "subAgentActivity",
  "enteredReviewMode",
  "exitedReviewMode"
]);
const SECRET_VALUE_PATTERN = /\b(?:sk-(?:proj|admin|service|svcacct)-[A-Za-z0-9_-]{12,}|Bearer\s+[A-Za-z0-9._-]{16,})\b/i;

export class ProbeError extends Error {
  constructor(code) {
    super(code);
    this.name = "ProbeError";
    this.code = code;
  }
}

export function safeExternalIdHash(value) {
  const normalized = normalizeProtocolId(value, PROBE_ERROR_CODES.INVALID_REQUEST);
  return createHash("sha256").update(normalized, "utf8").digest("hex");
}

export function projectProbeOutput(value) {
  assertPlainObject(value, PROBE_ERROR_CODES.OUTPUT_REJECTED);
  const allowed = new Set([
    "schemaVersion",
    "status",
    "phase",
    "mode",
    "errorCode",
    "runId",
    "taskCount",
    "restartCount",
    "answerCount",
    "continuationCount",
    "processGeneration",
    "requestMethod",
    "permissionProfileConfirmed",
    "threadIdSha256",
    "turnIdSha256",
    "itemIdSha256",
    "requestIdSha256",
    "requestIdType",
    "oldTurnIdSha256",
    "newTurnIdSha256",
    "recoveryDurationMs",
    "autoResolutionMs",
    "sameThread",
    "matchingPendingInput",
    "currentProcessRequest",
    "pendingInputCount",
    "pendingQuestionCount",
    "effectful",
    "unclassified",
    "historySafe",
    "responseAccepted",
    "turnCompletionObserved",
    "resolvedObserved",
    "turnCompletionStatus",
    "requestIdSame",
    "secondInvocationBlocked",
    "unseenRequestDisposition",
    "historyClassification",
    "cleanup",
    "streams",
    "budget"
  ]);
  if (Object.keys(value).some((key) => !allowed.has(key))) {
    throw probeError(PROBE_ERROR_CODES.OUTPUT_REJECTED);
  }
  if (value.schemaVersion !== 1 || !STATUS_VALUES.has(value.status)) {
    throw probeError(PROBE_ERROR_CODES.OUTPUT_REJECTED);
  }

  const output = { schemaVersion: 1, status: value.status };
  if (value.phase !== undefined) {
    assertEnum(value.phase, PROBE_PHASE_VALUES);
    output.phase = value.phase;
  }
  if (value.mode !== undefined) {
    assertEnum(value.mode, MODE_VALUES);
    output.mode = value.mode;
  }
  if (value.errorCode !== undefined) {
    if (value.errorCode !== null) {
      assertEnum(value.errorCode, ERROR_VALUES);
    }
    output.errorCode = value.errorCode;
  }
  if (value.runId !== undefined) {
    assertInternalUuid(value.runId);
    output.runId = value.runId;
  }
  for (const key of [
    "taskCount",
    "restartCount",
    "answerCount",
    "continuationCount",
    "processGeneration",
    "pendingInputCount",
    "pendingQuestionCount"
  ]) {
    if (value[key] !== undefined) {
      output[key] = boundedCount(value[key]);
    }
  }
  if (value.recoveryDurationMs !== undefined) {
    output.recoveryDurationMs = boundedDuration(value.recoveryDurationMs, 10 * 60 * 1000);
  }
  if (value.autoResolutionMs !== undefined) {
    if (value.autoResolutionMs !== null) {
      output.autoResolutionMs = boundedDuration(value.autoResolutionMs, MAX_AUTH_RESOLUTION_MS);
    } else {
      output.autoResolutionMs = null;
    }
  }
  if (value.requestMethod !== undefined) {
    assertEnum(value.requestMethod, REQUEST_METHOD_VALUES);
    output.requestMethod = value.requestMethod;
  }
  if (value.requestIdType !== undefined) {
    assertEnum(value.requestIdType, new Set(["string", "number"]));
    output.requestIdType = value.requestIdType;
  }
  for (const key of [
    "permissionProfileConfirmed",
    "sameThread",
    "matchingPendingInput",
    "currentProcessRequest",
    "effectful",
    "unclassified",
    "historySafe",
    "responseAccepted",
    "turnCompletionObserved",
    "resolvedObserved",
    "requestIdSame",
    "secondInvocationBlocked"
  ]) {
    if (value[key] !== undefined) {
      assertBoolean(value[key]);
      output[key] = value[key];
    }
  }
  if (value.turnCompletionStatus !== undefined) {
    assertEnum(value.turnCompletionStatus, TURN_COMPLETION_STATUS_VALUES);
    output.turnCompletionStatus = value.turnCompletionStatus;
  }
  for (const key of [
    "threadIdSha256",
    "turnIdSha256",
    "itemIdSha256",
    "requestIdSha256",
    "oldTurnIdSha256",
    "newTurnIdSha256"
  ]) {
    if (value[key] !== undefined) {
      assertSha256(value[key]);
      output[key] = value[key];
    }
  }
  if (value.unseenRequestDisposition !== undefined) {
    if (value.unseenRequestDisposition !== "NOT_ATTEMPTED_UNSEEN_REQUEST") {
      throw probeError(PROBE_ERROR_CODES.OUTPUT_REJECTED);
    }
    output.unseenRequestDisposition = value.unseenRequestDisposition;
  }
  if (value.historyClassification !== undefined) {
    assertEnum(value.historyClassification, new Set([
      "MATCHING_READ_ONLY_PENDING",
      "MISMATCHED_THREAD",
      "MISSING_PENDING_INPUT",
      "MULTIPLE_PENDING_INPUTS",
      "EFFECTFUL_HISTORY",
      "UNCLASSIFIED_HISTORY"
    ]));
    output.historyClassification = value.historyClassification;
  }
  if (value.cleanup !== undefined) {
    output.cleanup = projectCleanup(value.cleanup);
  }
  if (value.streams !== undefined) {
    output.streams = projectStreams(value.streams);
  }
  if (value.budget !== undefined) {
    output.budget = projectBudget(value.budget);
  }
  return output;
}

export class ProbeBudget {
  #limits;
  #used = { task: 0, restart: 0, answer: 0, continuation: 0 };

  constructor(limits = {}) {
    assertPlainObject(limits, PROBE_ERROR_CODES.INVALID_REQUEST);
    if (Object.keys(limits).some((key) => !Object.hasOwn(PROBE_LIMITS, key))) {
      throw probeError(PROBE_ERROR_CODES.INVALID_REQUEST);
    }
    this.#limits = { ...PROBE_LIMITS };
    for (const [kind, value] of Object.entries(limits)) {
      if (!Number.isSafeInteger(value) || value < 0 || value > PROBE_LIMITS[kind]) {
        throw probeError(PROBE_ERROR_CODES.INVALID_REQUEST);
      }
      this.#limits[kind] = value;
    }
  }

  reserve(kind) {
    if (!Object.hasOwn(this.#limits, kind) || this.#used[kind] >= this.#limits[kind]) {
      throw probeError(PROBE_ERROR_CODES.BUDGET_EXHAUSTED);
    }
    this.#used[kind] += 1;
    return this.#used[kind];
  }

  canReserve(kind) {
    return Object.hasOwn(this.#limits, kind) && this.#used[kind] < this.#limits[kind];
  }

  snapshot() {
    const remaining = {};
    for (const kind of Object.keys(this.#limits)) {
      remaining[kind] = this.#limits[kind] - this.#used[kind];
    }
    return {
      limits: { ...this.#limits },
      used: { ...this.#used },
      remaining
    };
  }
}

export class ServerRequestRegistry {
  #currentGeneration = null;
  #endedGenerations = new Set();
  #seenRequestKeys = new Set();
  #requestGenerations = new Map();
  #currentRequest = null;
  #durable = null;
  #answerConsumed = false;
  #serverRequestResolved = false;
  #unseenDisposition = "NOT_ATTEMPTED_UNSEEN_REQUEST";

  beginProcess(generation) {
    assertGeneration(generation);
    if (this.#currentGeneration !== null && generation <= this.#currentGeneration) {
      throw probeError(PROBE_ERROR_CODES.INVALID_REQUEST);
    }
    this.#currentGeneration = generation;
    this.#currentRequest = null;
    this.#answerConsumed = false;
    this.#serverRequestResolved = false;
    return generation;
  }

  endProcess(generation) {
    assertGeneration(generation);
    if (generation !== this.#currentGeneration) {
      throw probeError(PROBE_ERROR_CODES.STALE_REQUEST);
    }
    this.#endedGenerations.add(generation);
    this.#currentGeneration = null;
    this.#currentRequest = null;
  }

  observe({ processGeneration, requestId, method, params }) {
    assertGeneration(processGeneration);
    if (processGeneration !== this.#currentGeneration || this.#endedGenerations.has(processGeneration)) {
      throw probeError(PROBE_ERROR_CODES.STALE_REQUEST);
    }
    const requestKey = protocolIdKey(requestId);
    const generationRequestKey = `${processGeneration}:${requestKey}`;
    if (this.#seenRequestKeys.has(generationRequestKey)) {
      throw probeError(PROBE_ERROR_CODES.DUPLICATE_SERVER_REQUEST);
    }
    this.#seenRequestKeys.add(generationRequestKey);
    const requestGenerations = this.#requestGenerations.get(requestKey) ?? new Set();
    requestGenerations.add(processGeneration);
    this.#requestGenerations.set(requestKey, requestGenerations);
    if (method !== CODEX_APP_SERVER_METHODS.requestUserInput) {
      if ([
        CODEX_APP_SERVER_METHODS.commandApproval,
        CODEX_APP_SERVER_METHODS.fileApproval,
        CODEX_APP_SERVER_METHODS.permissionApproval
      ].includes(method)) {
        throw probeError(PROBE_ERROR_CODES.EFFECTFUL_REQUEST_REJECTED);
      }
      throw probeError(PROBE_ERROR_CODES.UNSUPPORTED_REQUEST);
    }

    const normalized = normalizeUserInputParams(params);
    assertControlledQuestions(normalized.questions);
    const identity = {
      requestId,
      requestKey,
      threadId: normalized.threadId,
      turnId: normalized.turnId,
      itemId: normalized.itemId,
      questionIds: normalized.questions.map((question) => question.id)
    };
    if (this.#currentRequest !== null) {
      throw probeError(PROBE_ERROR_CODES.DUPLICATE_SERVER_REQUEST);
    }
    this.#currentRequest = { identity, params: normalized };
    if (this.#durable === null) {
      this.#durable = { ...identity, params: normalized };
      return { kind: "INITIAL_REQUEST", identity: internalIdentity(identity) };
    }
    if (sameLogicalIdentity(this.#durable, identity)) {
      return { kind: "REISSUED_MATCH", identity: internalIdentity(identity) };
    }
    return { kind: "REISSUED_MISMATCH", identity: internalIdentity(identity) };
  }

  bindInitialTurn({ threadId, turnId }) {
    if (this.#durable === null || this.#durable.threadId !== threadId || this.#durable.turnId !== turnId) {
      throw probeError(PROBE_ERROR_CODES.REISSUED_REQUEST_MISMATCH);
    }
    return true;
  }

  assertControlledRequest() {
    assertControlledQuestions(this.#durable?.params.questions);
    return true;
  }

  consumeAnswer({ processGeneration, requestId, answers }) {
    if (processGeneration !== this.#currentGeneration || this.#currentRequest === null) {
      throw probeError(PROBE_ERROR_CODES.STALE_REQUEST);
    }
    const requestKey = protocolIdKey(requestId);
    if (requestKey !== this.#currentRequest.identity.requestKey) {
      const seenGenerations = this.#requestGenerations.get(requestKey);
      throw probeError(seenGenerations !== undefined
        && [...seenGenerations].some((generation) => generation < processGeneration)
        ? PROBE_ERROR_CODES.STALE_REQUEST
        : PROBE_ERROR_CODES.UNSEEN_REQUEST);
    }
    if (this.#durable === null || !sameLogicalIdentity(this.#durable, this.#currentRequest.identity)) {
      throw probeError(PROBE_ERROR_CODES.REISSUED_REQUEST_MISMATCH);
    }
    if (this.#answerConsumed) {
      throw probeError(PROBE_ERROR_CODES.ANSWER_ALREADY_CONSUMED);
    }
    if (this.#serverRequestResolved) {
      throw probeError(PROBE_ERROR_CODES.REQUEST_ALREADY_RESOLVED);
    }
    const normalized = normalizeAnswers(answers, this.#currentRequest.params.questions);
    this.#answerConsumed = true;
    return { answers: normalized };
  }

  markResolved() {
    if (this.#durable === null || !this.#answerConsumed) {
      throw probeError(PROBE_ERROR_CODES.INVALID_REQUEST);
    }
    this.#durable = null;
    this.#currentRequest = null;
  }

  resolveServerRequest(input) {
    assertPlainObject(input, PROBE_ERROR_CODES.INVALID_REQUEST);
    assertExactKeys(input, ["processGeneration", "requestId", "threadId"]);
    const { processGeneration, requestId, threadId } = input;
    assertGeneration(processGeneration);
    if (processGeneration !== this.#currentGeneration) {
      throw probeError(PROBE_ERROR_CODES.STALE_REQUEST);
    }
    if (this.#currentRequest === null) {
      throw probeError(PROBE_ERROR_CODES.UNSEEN_REQUEST);
    }
    const requestKey = protocolIdKey(requestId);
    if (requestKey !== this.#currentRequest.identity.requestKey) {
      const seenGenerations = this.#requestGenerations.get(requestKey);
      throw probeError(seenGenerations !== undefined
        && [...seenGenerations].some((generation) => generation < processGeneration)
        ? PROBE_ERROR_CODES.STALE_REQUEST
        : PROBE_ERROR_CODES.UNSEEN_REQUEST);
    }
    const normalizedThreadId = normalizeProtocolId(threadId, PROBE_ERROR_CODES.INVALID_REQUEST);
    if (normalizedThreadId !== this.#currentRequest.identity.threadId) {
      throw probeError(PROBE_ERROR_CODES.REISSUED_REQUEST_MISMATCH);
    }
    if (this.#durable === null || !sameLogicalIdentity(this.#durable, this.#currentRequest.identity)) {
      throw probeError(PROBE_ERROR_CODES.REISSUED_REQUEST_MISMATCH);
    }
    if (this.#serverRequestResolved) {
      throw probeError(PROBE_ERROR_CODES.DUPLICATE_SERVER_REQUEST);
    }
    this.#serverRequestResolved = true;
  }

  invalidatePending() {
    this.#durable = null;
    this.#currentRequest = null;
  }

  currentRequestIdentity() {
    return this.#currentRequest === null ? null : internalIdentity(this.#currentRequest.identity);
  }

  pendingIdentity() {
    return this.#durable === null ? null : internalIdentity(this.#durable);
  }

  currentRequestParameters() {
    return this.#currentRequest?.params ?? null;
  }

  hasCurrentRequest() {
    return this.#currentRequest !== null;
  }

  answerConsumed() {
    return this.#answerConsumed;
  }

  unseenRequestDisposition() {
    return this.#unseenDisposition;
  }

  snapshot() {
    return {
      currentProcessRequest: this.#currentRequest !== null,
      pendingInputCount: this.#durable === null ? 0 : 1,
      pendingQuestionCount: this.#durable?.params.questions.length ?? 0,
      answerConsumed: this.#answerConsumed,
      serverRequestResolved: this.#serverRequestResolved,
      unseenRequestDisposition: this.#unseenDisposition
    };
  }
}

export function classifyThreadHistory(response, pendingIdentity) {
  const result = {
    sameThread: false,
    matchingPendingInput: false,
    pendingInputCount: pendingIdentity === null ? 0 : 1,
    effectful: false,
    unclassified: false,
    historySafe: false,
    safeContinuation: false,
    historyClassification: "MISSING_PENDING_INPUT"
  };
  if (pendingIdentity === null || !isPlainObject(response) || !isPlainObject(response.thread)) {
    return result;
  }
  const thread = response.thread;
  if (typeof thread.id !== "string" || thread.id !== pendingIdentity.threadId) {
    result.historyClassification = "MISMATCHED_THREAD";
    return result;
  }
  result.sameThread = true;
  if (!Array.isArray(thread.turns)) {
    return result;
  }
  if (thread.turns.length !== 1) {
    result.pendingInputCount = 0;
    result.unclassified = true;
    result.historyClassification = "UNCLASSIFIED_HISTORY";
    return result;
  }
  const matchingTurns = thread.turns.filter((turn) => isPlainObject(turn) && turn.id === pendingIdentity.turnId);
  if (matchingTurns.length !== 1) {
    result.historyClassification = matchingTurns.length === 0
      ? "MISSING_PENDING_INPUT"
      : "MULTIPLE_PENDING_INPUTS";
    return result;
  }
  const turn = matchingTurns[0];
  if (!HISTORY_STATUS_VALUES.has(turn.status) || turn.status !== "inProgress" || !Array.isArray(turn.items)) {
    result.unclassified = true;
    result.historyClassification = "UNCLASSIFIED_HISTORY";
    return result;
  }
  if (turn.itemsView !== undefined && turn.itemsView !== "full") {
    result.unclassified = true;
    result.historyClassification = "UNCLASSIFIED_HISTORY";
    return result;
  }
  let matchingPendingItems = 0;
  for (const item of turn.items) {
    if (!isPlainObject(item) || typeof item.type !== "string" || typeof item.id !== "string") {
      result.unclassified = true;
      continue;
    }
    if (isPendingUserInputItem(item, pendingIdentity)) {
      matchingPendingItems += 1;
      continue;
    }
    if (EFFECTFUL_HISTORY_ITEM_TYPES.has(item.type)) {
      result.effectful = true;
      continue;
    }
    if (!SAFE_HISTORY_ITEM_TYPES.has(item.type)) {
      result.unclassified = true;
    }
  }
  result.pendingInputCount = matchingPendingItems;
  result.matchingPendingInput = matchingPendingItems === 1;
  result.historySafe = result.matchingPendingInput && !result.effectful && !result.unclassified;
  result.safeContinuation = result.historySafe;
  result.historyClassification = matchingPendingItems > 1
    ? "MULTIPLE_PENDING_INPUTS"
    : result.effectful
    ? "EFFECTFUL_HISTORY"
    : result.unclassified
      ? "UNCLASSIFIED_HISTORY"
      : matchingPendingItems === 0
        ? "MISSING_PENDING_INPUT"
        : "MATCHING_READ_ONLY_PENDING";
  return result;
}

export function createRecoveryBoundary({ budget = new ProbeBudget() } = {}) {
  return new RecoveryBoundary({ budget });
}

class RecoveryBoundary {
  #budget;
  #registry = new ServerRequestRegistry();
  #generation = 0;
  #leaseValid = true;
  #cancelled = false;
  #decision = null;
  #continuationTurnId = null;
  #continuationReserved = false;
  #continuationCommitted = false;

  constructor({ budget }) {
    if (!(budget instanceof ProbeBudget)) {
      throw probeError(PROBE_ERROR_CODES.INVALID_REQUEST);
    }
    this.#budget = budget;
  }

  beginTask() {
    this.#budget.reserve("task");
  }

  beginProcess(generation) {
    if (this.#generation !== 0 && generation <= this.#generation) {
      throw probeError(PROBE_ERROR_CODES.INVALID_REQUEST);
    }
    this.#generation = generation;
    this.#registry.beginProcess(generation);
  }

  endProcess(generation) {
    this.#registry.endProcess(generation);
  }

  observeRequest(input) {
    return this.#registry.observe(input);
  }

  observeServerRequest(input) {
    return this.observeRequest(input);
  }

  bindInitialTurn(identity) {
    this.#registry.bindInitialTurn(identity);
  }

  assertControlledRequest() {
    this.#registry.assertControlledRequest();
  }

  assertPendingInteraction() {
    const state = this.#registry.snapshot();
    if (!state.currentProcessRequest || state.answerConsumed || state.serverRequestResolved) {
      throw probeError(PROBE_ERROR_CODES.CODEX_PENDING_INTERACTION_NOT_RESUMABLE);
    }
  }

  resolveServerRequest(input) {
    this.#registry.resolveServerRequest(input);
  }

  loseLease() {
    this.#leaseValid = false;
  }

  cancel() {
    this.#cancelled = true;
  }

  decide(history) {
    if (this.#cancelled) {
      return this.#remember({ mode: RECOVERY_MODES.NOT_RESUMABLE, errorCode: PROBE_ERROR_CODES.CANCELLED });
    }
    if (!this.#leaseValid) {
      return this.#remember({ mode: RECOVERY_MODES.NOT_RESUMABLE, errorCode: PROBE_ERROR_CODES.LEASE_LOST });
    }
    const current = this.#registry.currentRequestIdentity();
    const pending = this.#registry.pendingIdentity();
    const registryState = this.#registry.snapshot();
    if (current !== null) {
      if (!registryState.serverRequestResolved
          && !registryState.answerConsumed
          && pending !== null
          && sameLogicalIdentity(current, pending)) {
        return this.#remember({
          mode: RECOVERY_MODES.REISSUED_REQUEST,
          errorCode: null,
          currentProcessRequest: true,
          matchingPendingInput: true,
          sameThread: true
        });
      }
      return this.#remember({
        mode: RECOVERY_MODES.NOT_RESUMABLE,
        errorCode: registryState.serverRequestResolved
          ? PROBE_ERROR_CODES.REQUEST_ALREADY_RESOLVED
          : PROBE_ERROR_CODES.REISSUED_REQUEST_MISMATCH,
        currentProcessRequest: true,
        unseenRequestDisposition: this.#registry.unseenRequestDisposition()
      });
    }
    const historyFacts = classifyThreadHistory(history, pending);
    if (historyFacts.safeContinuation) {
      return this.#remember({
        mode: RECOVERY_MODES.SAFE_CONTINUATION,
        errorCode: null,
        sameThread: historyFacts.sameThread,
        matchingPendingInput: true,
        currentProcessRequest: false,
        pendingInputCount: historyFacts.pendingInputCount,
        historySafe: true,
        historyClassification: historyFacts.historyClassification
      });
    }
    return this.#remember({
      mode: RECOVERY_MODES.NOT_RESUMABLE,
      errorCode: PROBE_ERROR_CODES.CODEX_PENDING_INTERACTION_NOT_RESUMABLE,
      sameThread: historyFacts.sameThread,
      matchingPendingInput: historyFacts.matchingPendingInput,
      currentProcessRequest: false,
      pendingInputCount: historyFacts.pendingInputCount,
      effectful: historyFacts.effectful,
      unclassified: historyFacts.unclassified,
      historySafe: false,
      historyClassification: historyFacts.historyClassification,
      unseenRequestDisposition: this.#registry.unseenRequestDisposition()
    });
  }

  answer(answers) {
    if (this.#cancelled) {
      throw probeError(PROBE_ERROR_CODES.CANCELLED);
    }
    if (!this.#leaseValid) {
      throw probeError(PROBE_ERROR_CODES.LEASE_LOST);
    }
    if (this.#decision?.mode !== RECOVERY_MODES.REISSUED_REQUEST) {
      throw probeError(PROBE_ERROR_CODES.UNSEEN_REQUEST);
    }
    this.#budget.reserve("answer");
    return this.#registry.consumeAnswer({
      processGeneration: this.#generation,
      requestId: this.#registry.currentRequestIdentity().requestId,
      answers
    });
  }

  startContinuation(newTurnId) {
    if (this.#cancelled) {
      throw probeError(PROBE_ERROR_CODES.CANCELLED);
    }
    if (!this.#leaseValid) {
      throw probeError(PROBE_ERROR_CODES.LEASE_LOST);
    }
    if (this.#decision?.mode !== RECOVERY_MODES.SAFE_CONTINUATION) {
      throw probeError(PROBE_ERROR_CODES.CODEX_PENDING_INTERACTION_NOT_RESUMABLE);
    }
    if (this.#continuationCommitted) {
      throw probeError(PROBE_ERROR_CODES.CODEX_PENDING_INTERACTION_NOT_RESUMABLE);
    }
    if (this.#registry.hasCurrentRequest()) {
      throw probeError(PROBE_ERROR_CODES.CODEX_PENDING_INTERACTION_NOT_RESUMABLE);
    }
    if (typeof newTurnId !== "string" || newTurnId.length === 0 || containsSecretLike(newTurnId)) {
      throw probeError(PROBE_ERROR_CODES.INVALID_REQUEST);
    }
    const oldTurnId = this.#registry.pendingIdentity()?.turnId;
    if (oldTurnId === newTurnId) {
      throw probeError(PROBE_ERROR_CODES.INVALID_REQUEST);
    }
    if (!this.#continuationReserved) {
      this.#budget.reserve("answer");
      this.#budget.reserve("continuation");
      this.#continuationReserved = true;
    }
    return this.recordContinuationConfirmed(newTurnId);
  }

  recordContinuationConfirmed(newTurnId) {
    if (this.#continuationCommitted) {
      throw probeError(PROBE_ERROR_CODES.CODEX_PENDING_INTERACTION_NOT_RESUMABLE);
    }
    if (this.#decision?.mode !== RECOVERY_MODES.SAFE_CONTINUATION || !this.#continuationReserved) {
      throw probeError(PROBE_ERROR_CODES.CODEX_PENDING_INTERACTION_NOT_RESUMABLE);
    }
    if (typeof newTurnId !== "string" || newTurnId.length === 0 || containsSecretLike(newTurnId)) {
      throw probeError(PROBE_ERROR_CODES.INVALID_REQUEST);
    }
    const oldTurnId = this.#registry.pendingIdentity()?.turnId;
    if (oldTurnId === newTurnId) {
      throw probeError(PROBE_ERROR_CODES.INVALID_REQUEST);
    }
    this.#continuationCommitted = true;
    this.#continuationTurnId = newTurnId;
    return {
      oldTurnIdSha256: safeExternalIdHash(oldTurnId),
      newTurnIdSha256: safeExternalIdHash(newTurnId)
    };
  }

  assertContinuationOutcomeAllowed() {
    if (this.#cancelled) {
      throw probeError(PROBE_ERROR_CODES.CANCELLED);
    }
    if (!this.#leaseValid) {
      throw probeError(PROBE_ERROR_CODES.LEASE_LOST);
    }
    if (this.#decision?.mode !== RECOVERY_MODES.SAFE_CONTINUATION
        || !this.#continuationReserved || !this.#continuationCommitted) {
      throw probeError(PROBE_ERROR_CODES.CODEX_PENDING_INTERACTION_NOT_RESUMABLE);
    }
    if (this.#registry.hasCurrentRequest()) {
      throw probeError(PROBE_ERROR_CODES.CODEX_PENDING_INTERACTION_NOT_RESUMABLE);
    }
  }

  prepareContinuation() {
    if (this.#cancelled) {
      throw probeError(PROBE_ERROR_CODES.CANCELLED);
    }
    if (!this.#leaseValid) {
      throw probeError(PROBE_ERROR_CODES.LEASE_LOST);
    }
    if (this.#decision?.mode !== RECOVERY_MODES.SAFE_CONTINUATION || this.#continuationReserved) {
      throw probeError(PROBE_ERROR_CODES.CODEX_PENDING_INTERACTION_NOT_RESUMABLE);
    }
    if (this.#registry.hasCurrentRequest()) {
      throw probeError(PROBE_ERROR_CODES.CODEX_PENDING_INTERACTION_NOT_RESUMABLE);
    }
    this.#budget.reserve("answer");
    this.#budget.reserve("continuation");
    this.#continuationReserved = true;
  }

  assertContinuationAllowed() {
    if (this.#cancelled || !this.#leaseValid || this.#decision?.mode !== RECOVERY_MODES.SAFE_CONTINUATION
        || !this.#continuationReserved || this.#continuationCommitted || this.#registry.hasCurrentRequest()) {
      throw probeError(PROBE_ERROR_CODES.CODEX_PENDING_INTERACTION_NOT_RESUMABLE);
    }
  }

  beginRestart() {
    this.#budget.reserve("restart");
  }

  complete() {
    if (this.#decision?.mode === RECOVERY_MODES.REISSUED_REQUEST) {
      if (!this.#registry.answerConsumed()) {
        throw probeError(PROBE_ERROR_CODES.ANSWER_INVALID);
      }
      this.#registry.markResolved();
    } else if (this.#decision?.mode === RECOVERY_MODES.SAFE_CONTINUATION) {
      if (this.#continuationTurnId === null) {
        throw probeError(PROBE_ERROR_CODES.CODEX_PENDING_INTERACTION_NOT_RESUMABLE);
      }
      this.#registry.invalidatePending();
    }
  }

  budgetSnapshot() {
    return this.#budget.snapshot();
  }

  registrySnapshot() {
    return this.#registry.snapshot();
  }

  currentRequestIdentity() {
    return this.#registry.currentRequestIdentity();
  }

  currentRequestParameters() {
    return this.#registry.currentRequestParameters();
  }

  #remember(decision) {
    this.#decision = {
      unseenRequestDisposition: this.#registry.unseenRequestDisposition(),
      ...decision
    };
    return { ...this.#decision };
  }
}

export function buildProductPermissionArguments({ taskId, allowedRoot }) {
  if (!INTERNAL_UUID_PATTERN.test(taskId ?? "") || !isAbsolute(allowedRoot) || containsControlCharacters(allowedRoot)) {
    throw probeError(PROBE_ERROR_CODES.INVALID_PERMISSION_PROFILE);
  }
  const profileId = `jarvis-task-${taskId.replaceAll("-", "")}`;
  const sensitiveGlobs = [
    ".env",
    "**/.env",
    ".env.*",
    "**/.env.*",
    "*.env",
    "**/*.env",
    ".ssh",
    ".ssh/**",
    "**/.ssh",
    "**/.ssh/**",
    ".aws",
    ".aws/**",
    "**/.aws",
    "**/.aws/**",
    ".azure",
    ".azure/**",
    "**/.azure",
    "**/.azure/**",
    ".config/gcloud",
    ".config/gcloud/**",
    "**/.config/gcloud",
    "**/.config/gcloud/**",
    "id_rsa",
    "**/id_rsa",
    "id_ed25519",
    "**/id_ed25519",
    "credentials",
    "credentials/**",
    "**/credentials",
    "**/credentials/**",
    "secrets.json",
    "**/secrets.json"
  ];
  const entries = [
    [":minimal", "read"],
    [allowedRoot, "read"],
    ...sensitiveGlobs.map((glob) => [join(allowedRoot, glob), "deny"])
  ];
  const filesystem = `{${entries.map(([key, value]) => `${tomlString(key)}=${tomlString(value)}`).join(",")}}`;
  return [
    "app-server",
    "-c",
    "features.default_mode_request_user_input=true",
    "-c",
    "features.request_permissions_tool=true",
    "-c",
    `default_permissions=${tomlString(profileId)}`,
    "-c",
    `permissions.${tomlString(profileId)}.filesystem=${filesystem}`,
    "-c",
    `permissions.${tomlString(profileId)}.network.enabled=false`,
    "-c",
    `cli_auth_credentials_store=${tomlString("file")}`
  ];
}

export function buildProbeEnvironment({
  codexHome,
  tmpDirectory,
  allowedRoot,
  homeDirectory,
  path = process.env.PATH ?? "/usr/bin:/bin"
} = {}) {
  const values = { codexHome, tmpDirectory, allowedRoot, homeDirectory, path };
  if (Object.values(values).some((value) => typeof value !== "string" || value.length === 0)) {
    throw probeError(PROBE_ERROR_CODES.INVALID_ENVIRONMENT);
  }
  for (const value of [codexHome, tmpDirectory, allowedRoot, homeDirectory]) {
    if (!isAbsolute(value) || containsControlCharacters(value) || value.length > 1024) {
      throw probeError(PROBE_ERROR_CODES.INVALID_ENVIRONMENT);
    }
  }
  if (containsControlCharacters(path) || path.length > 1024 || path.includes("\n")) {
    throw probeError(PROBE_ERROR_CODES.INVALID_ENVIRONMENT);
  }
  return {
    CODEX_HOME: codexHome,
    TMPDIR: tmpDirectory,
    JARVIS_ALLOWED_ROOT: allowedRoot,
    HOME: homeDirectory,
    PATH: path,
    LANG: "en_US.UTF-8",
    cli_auth_credentials_store: "file"
  };
}

export async function verifyAuthMetadata(metadataPath, { expectedUid = process.getuid?.() ?? -1 } = {}) {
  if (typeof metadataPath !== "string" || !isAbsolute(metadataPath)) {
    throw probeError(PROBE_ERROR_CODES.AUTH_METADATA_INVALID);
  }
  if (basename(metadataPath) !== "login-metadata.json") {
    throw probeError(PROBE_ERROR_CODES.AUTH_METADATA_INVALID);
  }
  await assertNoSymlinkPath(metadataPath);
  const authRoot = dirname(metadataPath);
  const rootStat = await lstat(authRoot).catch(() => null);
  if (rootStat === null || !rootStat.isDirectory() || !isOwnerOnly(rootStat, 0o700, expectedUid)
      || !/^protocol-auth-[A-Za-z0-9_-]+$/.test(basename(authRoot))) {
    throw probeError(PROBE_ERROR_CODES.AUTH_METADATA_INVALID);
  }
  const metadata = await readPrivateJson(metadataPath, expectedUid, MAX_AUTH_METADATA_BYTES);
  assertPlainObject(metadata, PROBE_ERROR_CODES.AUTH_METADATA_INVALID);
  if (!sameKeys(metadata, AUTH_METADATA_KEYS)
      || metadata.schemaVersion !== 1
      || metadata.authenticationCompleted !== true
      || metadata.credentialStore !== "file"
      || metadata.previousRuntimeReused !== false
      || !INTERNAL_UUID_PATTERN.test(metadata.runId ?? "")) {
    throw probeError(PROBE_ERROR_CODES.AUTH_METADATA_INVALID);
  }
  const expectedDirectories = {
    codexHome: join(authRoot, "codex-home"),
    runtimeRoot: authRoot,
    allowedRoot: join(authRoot, "allowed-root"),
    homeDirectory: join(authRoot, "home"),
    tmpDirectory: join(authRoot, "tmp")
  };
  if (metadata.codexHome !== expectedDirectories.codexHome
      || metadata.runtimeRoot !== expectedDirectories.runtimeRoot
      || metadata.allowedRoot !== expectedDirectories.allowedRoot) {
    throw probeError(PROBE_ERROR_CODES.AUTH_METADATA_INVALID);
  }
  const directories = {
    codexHome: expectedDirectories.codexHome,
    runtimeRoot: expectedDirectories.runtimeRoot,
    allowedRoot: expectedDirectories.allowedRoot,
    homeDirectory: expectedDirectories.homeDirectory,
    tmpDirectory: expectedDirectories.tmpDirectory
  };
  if (new Set(Object.values(directories)).size !== Object.keys(directories).length) {
    throw probeError(PROBE_ERROR_CODES.AUTH_METADATA_INVALID);
  }
  for (const path of Object.values(directories)) {
    if (typeof path !== "string" || !isAbsolute(path) || !isWithin(path, authRoot)) {
      throw probeError(PROBE_ERROR_CODES.AUTH_METADATA_INVALID);
    }
    await assertNoSymlinkPath(path);
    const pathStat = await lstat(path).catch(() => null);
    if (pathStat === null || !pathStat.isDirectory() || !isOwnerOnly(pathStat, 0o700, expectedUid)) {
      throw probeError(PROBE_ERROR_CODES.AUTH_METADATA_INVALID);
    }
  }
  await assertPrivateFile(join(directories.codexHome, "auth.json"), expectedUid, 0o600, MAX_AUTH_FILE_BYTES);
  return Object.freeze({
    runId: metadata.runId,
    codexHome: directories.codexHome,
    runtimeRoot: directories.runtimeRoot,
    allowedRoot: directories.allowedRoot,
    homeDirectory: directories.homeDirectory,
    tmpDirectory: directories.tmpDirectory,
    metadataRoot: authRoot
  });
}

export async function verifyPinnedCodex(binaryPath, { expectedSha256 = PINNED_CODEX.sha256 } = {}) {
  if (typeof binaryPath !== "string" || !isAbsolute(binaryPath)) {
    throw probeError(PROBE_ERROR_CODES.PINNED_BINARY_MISMATCH);
  }
  await assertNoSymlinkPath(binaryPath);
  const metadata = await lstat(binaryPath).catch(() => null);
  if (metadata === null || !metadata.isFile() || (metadata.mode & 0o111) === 0) {
    throw probeError(PROBE_ERROR_CODES.PINNED_BINARY_MISMATCH);
  }
  const digest = await sha256File(binaryPath);
  if (digest !== expectedSha256) {
    throw probeError(PROBE_ERROR_CODES.PINNED_BINARY_MISMATCH);
  }
  return true;
}

export async function claimProbeConsumption(metadataRoot, runId, { expectedUid = process.getuid?.() ?? -1 } = {}) {
  if (typeof metadataRoot !== "string" || !isAbsolute(metadataRoot) || !INTERNAL_UUID_PATTERN.test(runId ?? "")) {
    throw probeError(PROBE_ERROR_CODES.AUTH_METADATA_INVALID);
  }
  await assertNoSymlinkPath(metadataRoot);
  const markerPath = join(metadataRoot, ".phase9b-codex-probe-consumed");
  const existing = await lstat(markerPath).catch(() => null);
  if (existing !== null) {
    if (existing.isSymbolicLink() || !existing.isFile() || !isOwnerOnly(existing, 0o600, expectedUid)) {
      throw probeError(PROBE_ERROR_CODES.AUTH_METADATA_INVALID);
    }
    throw probeError(PROBE_ERROR_CODES.PROBE_ALREADY_CONSUMED);
  }
  let handle;
  try {
    handle = await open(markerPath, "wx", 0o600);
    await handle.writeFile(`${JSON.stringify({ schemaVersion: 1, runId, purpose: "codex-restart-probe" })}\n`, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await chmod(markerPath, 0o600);
    return markerPath;
  } catch (error) {
    await handle?.close().catch(() => {});
    if (error?.code === "EEXIST") {
      throw probeError(PROBE_ERROR_CODES.PROBE_ALREADY_CONSUMED);
    }
    throw probeError(PROBE_ERROR_CODES.AUTH_METADATA_INVALID);
  }
}

export function createMonotonicDeadline(durationMs = PROBE_DURATION_MS, now = monotonicNow) {
  if (!Number.isSafeInteger(durationMs) || durationMs <= 0 || durationMs > 10 * 60 * 1000) {
    throw probeError(PROBE_ERROR_CODES.DEADLINE_EXCEEDED);
  }
  const started = now();
  const deadline = started + durationMs;
  return Object.freeze({
    started,
    deadline,
    remaining() {
      return Math.max(0, deadline - now());
    },
    expired() {
      return now() >= deadline;
    }
  });
}

export async function runCodexRestartProbe({
  codexPath = process.env.PHASE9B_CODEX_PATH,
  authMetadataPath = process.env.PHASE9B_CODEX_AUTH_METADATA,
  spawnProcess = nodeSpawn,
  now = monotonicNow,
  maxDurationMs = PROBE_DURATION_MS,
  signal = undefined,
  securityRemediationStatus = process.env.PHASE9B_SECURITY_REMEDIATION_STATUS,
  offlineGatesPassed = process.env.PHASE9BR_OFFLINE_DESKTOP_GATES_PASSED === "1",
  testSeam = undefined
} = {}) {
  const cleanupState = { completed: false, processGroupGone: false, forcedKill: false };
  const boundary = createRecoveryBoundary();
  const result = {
    schemaVersion: 1,
    status: "FAIL",
    taskCount: 0,
    restartCount: 0,
    answerCount: 0,
    continuationCount: 0,
    permissionProfileConfirmed: false,
    resolvedObserved: false,
    cleanup: cleanupState
  };
  const deadline = createMonotonicDeadline(maxDurationMs, now);
  const finish = (patch = {}) => projectProbeOutput({ ...result, ...patch, cleanup: cleanupState });
  let auth;
  let firstServer;
  let secondServer;
  let finalPatch = {};
  let phase = "gate";
  let recoveryStarted;
  let firstStopResult;
  let secondStopResult;
  let probeThreadId;
  let probeTurnId;
  try {
    assertProbeRunGates({ securityRemediationStatus, offlineGatesPassed });
    throwIfAborted(signal);
    const seam = resolveProbeTestSeam(testSeam, spawnProcess);
    phase = "auth";
    auth = await seam.verifyAuthMetadata(authMetadataPath);
    result.runId = auth.runId;
    phase = "claim";
    await seam.claimProbeConsumption(auth.metadataRoot, auth.runId);
    const taskId = randomUUID();
    const profileArgs = buildProductPermissionArguments({ taskId, allowedRoot: auth.allowedRoot });
    const expectedProfileId = extractProfileIdFromArgs(profileArgs);
    const environment = buildProbeEnvironment(auth);
    boundary.beginTask();
    result.taskCount = 1;

    phase = "pinned";
    await seam.verifyPinnedCodex(codexPath);
    throwIfAborted(signal);
    phase = "first-spawn";
    boundary.beginProcess(1);
    firstServer = await createAppServer({
      command: codexPath,
      args: profileArgs,
      cwd: auth.allowedRoot,
      env: environment,
      spawnProcess,
      deadline,
      signal,
      processLifecycleFactory: seam.createProcessLifecycle,
      processGeneration: 1,
      onServerRequest: (request) => {
        const observed = boundary.observeServerRequest({ ...request, processGeneration: 1 });
        if (observed.kind === "REISSUED_MISMATCH") {
          // The process is stopped by the owning flow after the request is
          // classified. No unsolicited response is sent.
        }
      },
      onServerRequestResolved: ({ processGeneration, requestId, threadId }) => {
        result.resolvedObserved = true;
        boundary.resolveServerRequest({ processGeneration, requestId, threadId });
      }
    });
    phase = "first-initialize";
    await firstServer.initialize(deadline);
    throwIfAborted(signal);
    phase = "thread-start";
    const threadResponse = await firstServer.request(CODEX_APP_SERVER_METHODS.threadStart, {
      cwd: auth.allowedRoot,
      approvalPolicy: "on-request"
    }, deadline);
    const profileId = extractProfileId(threadResponse);
    result.permissionProfileConfirmed = profileId === expectedProfileId;
    if (!result.permissionProfileConfirmed) {
      throw probeError(PROBE_ERROR_CODES.PERMISSION_PROFILE_UNCONFIRMED);
    }
    const threadId = extractThreadId(threadResponse);
    probeThreadId = threadId;
    phase = "turn-start";
    const turnResponse = await firstServer.request(CODEX_APP_SERVER_METHODS.turnStart, {
      threadId,
      input: [{ type: "text", text: CONTROLLED_TASK_PROMPT }]
    }, deadline);
    const turnId = extractTurnId(turnResponse);
    probeTurnId = turnId;
    phase = "await-input";
    await firstServer.waitForUserInput(deadline);
    firstServer.assertHealthy();
    if (firstServer.hasTurnCompletion(threadId, turnId)) {
      throw probeError(PROBE_ERROR_CODES.PROBE_RUNTIME_ERROR);
    }
    phase = "bind-input";
    boundary.bindInitialTurn({ threadId, turnId });
    boundary.assertControlledRequest();
    boundary.assertPendingInteraction();
    const firstRequest = boundaryRequestIdentity(boundary);
    const firstRequestParams = boundaryRequestParameters(boundary);
    result.requestMethod = CODEX_APP_SERVER_METHODS.requestUserInput;
    result.requestIdType = typeof firstRequest.requestId;
    result.requestIdSha256 = safeExternalIdHash(firstRequest.requestId);
    result.itemIdSha256 = safeExternalIdHash(firstRequest.itemId);
    result.autoResolutionMs = firstRequestParams.autoResolutionMs ?? null;
    result.threadIdSha256 = safeExternalIdHash(threadId);
    result.turnIdSha256 = safeExternalIdHash(turnId);
    phase = "first-stop";
    firstStopResult = await firstServer.stop();
    if (!firstStopResult.completed || !firstStopResult.processGroupGone) {
      throw probeError(PROBE_ERROR_CODES.PROCESS_CLEANUP_FAILED);
    }
    const firstStopFacts = firstServer.observedFacts(threadId, turnId);
    result.resolvedObserved ||= firstStopFacts.resolvedObserved;
    result.turnCompletionObserved ||= firstStopFacts.turnCompletionObserved;
    if (firstStopFacts.turnCompletionObserved) {
      result.turnCompletionStatus = firstStopFacts.turnCompletionStatus;
    }
    if (firstStopFacts.fatalCode !== undefined) {
      throw probeError(firstStopFacts.fatalCode);
    }
    if (firstStopFacts.resolvedObserved || firstStopFacts.turnCompletionObserved) {
      throw probeError(PROBE_ERROR_CODES.PROBE_RUNTIME_ERROR);
    }
    boundary.endProcess(1);

    phase = "restart";
    boundary.beginRestart();
    result.restartCount = 1;
    recoveryStarted = now();
    const recoveryDeadline = createMonotonicDeadline(
      Math.min(DECISION_WAIT_WINDOW_MS, deadline.remaining()),
      now
    );
    let lateRecoveryRequest = false;
    throwIfAborted(signal);
    phase = "recovery-spawn";
    await seam.verifyPinnedCodex(codexPath);
    boundary.beginProcess(2);
    secondServer = await createAppServer({
      command: codexPath,
      args: profileArgs,
      cwd: auth.allowedRoot,
      env: environment,
      spawnProcess,
      deadline,
      signal,
      processLifecycleFactory: seam.createProcessLifecycle,
      processGeneration: 2,
      onServerRequest: (request) => {
        lateRecoveryRequest ||= recoveryDeadline.expired();
        boundary.observeServerRequest({ ...request, processGeneration: 2 });
      },
      onServerRequestResolved: ({ processGeneration, requestId, threadId }) => {
        result.resolvedObserved = true;
        boundary.resolveServerRequest({ processGeneration, requestId, threadId });
      }
    });
    phase = "recovery-initialize";
    await secondServer.initialize(recoveryDeadline);
    throwIfAborted(signal);
    phase = "resume";
    const resumeResponse = await secondServer.request(CODEX_APP_SERVER_METHODS.threadResume, {
      threadId,
      cwd: auth.allowedRoot,
      approvalPolicy: "on-request"
    }, recoveryDeadline);
    result.permissionProfileConfirmed = result.permissionProfileConfirmed
      && extractProfileId(resumeResponse) === expectedProfileId;
    if (!result.permissionProfileConfirmed) {
      throw probeError(PROBE_ERROR_CODES.PERMISSION_PROFILE_UNCONFIRMED);
    }
    phase = "read";
    const historyResponse = await secondServer.request(CODEX_APP_SERVER_METHODS.threadRead, {
      threadId,
      includeTurns: true
    }, recoveryDeadline);
    if (lateRecoveryRequest) {
      throw probeError(PROBE_ERROR_CODES.DEADLINE_EXCEEDED);
    }
    try {
      await secondServer.waitForUserInput(recoveryDeadline);
      secondServer.assertHealthy();
    } catch (error) {
      if (error?.code !== PROBE_ERROR_CODES.PROTOCOL_TIMEOUT
          && error?.code !== PROBE_ERROR_CODES.DEADLINE_EXCEEDED) {
        throw error;
      }
      secondServer.assertHealthy();
    }
    if (lateRecoveryRequest) {
      throw probeError(PROBE_ERROR_CODES.DEADLINE_EXCEEDED);
    }
    const recoveryDurationMs = Math.round(now() - recoveryStarted);
    if (recoveryDurationMs > MAX_RECOVERY_DURATION_MS) {
      throw probeError(PROBE_ERROR_CODES.DEADLINE_EXCEEDED);
    }
    result.recoveryDurationMs = recoveryDurationMs;
    phase = "decision";
    const decision = boundary.decide(historyResponse);
    result.mode = decision.mode;
    result.errorCode = decision.errorCode;
    result.sameThread = decision.sameThread ?? false;
    result.matchingPendingInput = decision.matchingPendingInput ?? false;
    result.currentProcessRequest = decision.currentProcessRequest ?? false;
    result.historySafe = decision.historySafe ?? false;
    result.effectful = decision.effectful ?? false;
    result.unclassified = decision.unclassified ?? false;
    result.historyClassification = decision.historyClassification;
    result.unseenRequestDisposition = decision.unseenRequestDisposition;
    result.pendingInputCount = boundary.registrySnapshot().pendingInputCount;
    result.pendingQuestionCount = boundary.registrySnapshot().pendingQuestionCount;
    if (decision.mode === RECOVERY_MODES.REISSUED_REQUEST) {
      phase = "answer";
      throwIfAborted(signal);
      secondServer.assertHealthy();
      const currentRequest = boundaryRequestIdentity(boundary);
      const params = boundaryRequestParameters(boundary);
      const answers = Object.fromEntries(params.questions.map((question) => [question.id, { answers: ["alpha"] }]));
      const response = boundary.answer(answers);
      await secondServer.respond(currentRequest.requestId, response);
      result.answerCount = 1;
      throwIfAborted(signal);
      phase = "completion";
      result.responseAccepted = await secondServer.waitForTurnCompletion(threadId, turnId, deadline);
      secondServer.assertHealthy();
      result.turnCompletionObserved = secondServer.hasTurnCompletion(threadId, turnId);
      result.turnCompletionStatus = secondServer.turnCompletionStatus(threadId, turnId);
      if (!result.turnCompletionObserved) {
        throw probeError(PROBE_ERROR_CODES.PROTOCOL_TIMEOUT);
      }
      if (result.turnCompletionStatus !== "completed" || !result.responseAccepted) {
        throw probeError(PROBE_ERROR_CODES.PROBE_RUNTIME_ERROR);
      }
      boundary.complete();
      result.status = "PASS";
    } else if (decision.mode === RECOVERY_MODES.SAFE_CONTINUATION) {
      phase = "continuation";
      throwIfAborted(signal);
      boundary.prepareContinuation();
      throwIfAborted(signal);
      secondServer.assertHealthy();
      boundary.assertContinuationAllowed();
      const continuationResponse = await secondServer.request(CODEX_APP_SERVER_METHODS.turnStart, {
        threadId,
        input: [{
          type: "text",
          text: buildContinuationPrompt({ taskId, questionId: "choice", answer: "alpha" })
        }]
      }, deadline, () => boundary.assertContinuationAllowed());
      const continuationTurnId = extractTurnId(continuationResponse);
      probeTurnId = continuationTurnId;
      const audit = boundary.recordContinuationConfirmed(continuationTurnId);
      result.oldTurnIdSha256 = audit.oldTurnIdSha256;
      result.newTurnIdSha256 = audit.newTurnIdSha256;
      result.answerCount = 1;
      result.continuationCount = 1;
      boundary.assertContinuationOutcomeAllowed();
      phase = "completion";
      result.responseAccepted = await secondServer.waitForTurnCompletion(threadId, continuationTurnId, deadline);
      secondServer.assertHealthy();
      result.turnCompletionObserved = secondServer.hasTurnCompletion(threadId, continuationTurnId);
      result.turnCompletionStatus = secondServer.turnCompletionStatus(threadId, continuationTurnId);
      result.responseAccepted = result.responseAccepted
        && result.turnCompletionObserved
        && result.turnCompletionStatus === "completed";
      if (!result.turnCompletionObserved) {
        throw probeError(PROBE_ERROR_CODES.PROTOCOL_TIMEOUT);
      }
      if (!result.responseAccepted) {
        throw probeError(PROBE_ERROR_CODES.PROBE_RUNTIME_ERROR);
      }
      boundary.complete();
      result.status = "PASS";
    } else {
      if (decision.errorCode !== PROBE_ERROR_CODES.CODEX_PENDING_INTERACTION_NOT_RESUMABLE) {
        throw probeError(decision.errorCode ?? PROBE_ERROR_CODES.PROBE_RUNTIME_ERROR);
      }
      result.status = "BLOCKED_CODEX_PROTOCOL_LIMITATION";
    }
    finalPatch = {
      status: result.status,
      errorCode: result.status === "PASS" ? null : result.errorCode
    };
  } catch (error) {
    const code = ERROR_VALUES.has(error?.code) ? error.code : PROBE_ERROR_CODES.PROBE_RUNTIME_ERROR;
    if (recoveryStarted !== undefined && result.recoveryDurationMs === undefined) {
      result.recoveryDurationMs = Math.round(now() - recoveryStarted);
    }
    finalPatch = {
      status: code === PROBE_ERROR_CODES.SECURITY_GATE_REQUIRED
        ? "BLOCKED_SECURITY_REMEDIATION"
        : code === PROBE_ERROR_CODES.OFFLINE_GATES_REQUIRED ? "UNVERIFIED"
          : code === PROBE_ERROR_CODES.CANCELLED ? "CANCELLED" : "FAIL",
      errorCode: code
    };
  } finally {
    secondStopResult = await stopServerSafely(secondServer);
    if (secondServer !== undefined && probeThreadId !== undefined && probeTurnId !== undefined) {
      const secondStopFacts = secondServer.observedFacts(probeThreadId, probeTurnId);
      result.resolvedObserved ||= secondStopFacts.resolvedObserved;
      result.turnCompletionObserved ||= secondStopFacts.turnCompletionObserved;
      if (secondStopFacts.turnCompletionObserved) {
        result.turnCompletionStatus = secondStopFacts.turnCompletionStatus;
      }
      if (secondStopFacts.fatalCode !== undefined) {
        finalPatch = {
          status: secondStopFacts.fatalCode === PROBE_ERROR_CODES.CANCELLED
            ? "CANCELLED" : "FAIL",
          errorCode: secondStopFacts.fatalCode
        };
      }
    }
    if (firstStopResult === undefined) {
      firstStopResult = await stopServerSafely(firstServer);
    }
    const stopResults = [firstStopResult, secondStopResult].filter(Boolean);
    cleanupState.completed = stopResults.every((stop) => stop.completed);
    cleanupState.processGroupGone = stopResults.every((stop) => stop.processGroupGone);
    cleanupState.forcedKill = stopResults.some((stop) => stop.forcedKill);
    result.streams = mergeStreamSnapshots(stopResults);
    if (!cleanupState.completed || !cleanupState.processGroupGone) {
      finalPatch = {
        status: "FAIL",
        errorCode: PROBE_ERROR_CODES.PROCESS_CLEANUP_FAILED
      };
    }
    // The metadata root belongs to the caller's fresh-login helper. The probe
    // only claims its one-time marker and never removes or copies that home.
  }
  result.budget = boundary.budgetSnapshot();
  result.phase = phase;
  return finish(finalPatch);
}

function resolveProbeTestSeam(testSeam, spawnProcess) {
  if (testSeam === undefined) {
    return {
      verifyAuthMetadata,
      verifyPinnedCodex,
      claimProbeConsumption,
      createProcessLifecycle: undefined
    };
  }
  // A fake child may only be supplied by the code-owned offline seam. The
  // production CLI never provides this object and the native spawn path is
  // deliberately rejected here.
  if (spawnProcess === nodeSpawn || !isPlainObject(testSeam)) {
    throw probeError(PROBE_ERROR_CODES.INVALID_REQUEST);
  }
  assertExactKeys(testSeam, ["verifyAuthMetadata", "verifyPinnedCodex", "claimProbeConsumption"], ["createProcessLifecycle"]);
  if (Object.entries(testSeam).some(([key, value]) => key !== "createProcessLifecycle" && typeof value !== "function")
      || testSeam.createProcessLifecycle !== undefined && typeof testSeam.createProcessLifecycle !== "function") {
    throw probeError(PROBE_ERROR_CODES.INVALID_REQUEST);
  }
  return testSeam;
}

async function stopServerSafely(server) {
  if (server === undefined) {
    return undefined;
  }
  try {
    return await server.stop();
  } catch {
    return {
      completed: false,
      processGroupGone: false,
      forcedKill: true,
      streams: {
        stdout: { observed: false, suppressed: true },
        stderr: { observed: false, suppressed: true }
      }
    };
  }
}

function mergeStreamSnapshots(stopResults) {
  return {
    stdout: {
      observed: stopResults.some((stop) => stop.streams?.stdout?.observed === true),
      suppressed: true
    },
    stderr: {
      observed: stopResults.some((stop) => stop.streams?.stderr?.observed === true),
      suppressed: true
    }
  };
}

export async function createAppServer({
  command,
  args,
  cwd,
  env,
  spawnProcess = nodeSpawn,
  deadline,
  onServerRequest,
  onServerRequestResolved = undefined,
  processGeneration = undefined,
  signal = undefined,
  processLifecycleFactory = undefined,
  onSpawn = undefined
}) {
  if (typeof command !== "string" || !isAbsolute(command) || !Array.isArray(args)
      || typeof spawnProcess !== "function" || !isAbsolute(cwd) || !isPlainObject(env)
      || !(deadline?.remaining instanceof Function)
      || onServerRequest !== undefined && typeof onServerRequest !== "function"
      || onServerRequestResolved !== undefined && typeof onServerRequestResolved !== "function"
      || processGeneration !== undefined && (!Number.isSafeInteger(processGeneration) || processGeneration < 1 || processGeneration > 2)
      || processLifecycleFactory !== undefined && typeof processLifecycleFactory !== "function"
      || onSpawn !== undefined && typeof onSpawn !== "function") {
    throw probeError(PROBE_ERROR_CODES.INVALID_REQUEST);
  }
  const child = spawnProcess(command, args, {
    cwd,
    env: assertProbeEnvironment(env),
    detached: process.platform !== "win32",
    stdio: ["pipe", "pipe", "pipe"]
  });
  onSpawn?.(child);
  const processLifecycle = processLifecycleFactory?.(child)
    ?? (spawnProcess === nodeSpawn
      ? createNativeProcessLifecycle(child)
      : createUnownedProcessLifecycle(child));
  assertProcessLifecycle(processLifecycle);
  return new JsonRpcAppServer({
    child,
    deadline,
    onServerRequest,
    onServerRequestResolved,
    processGeneration,
    signal,
    processLifecycle
  });
}

function assertProcessLifecycle(value) {
  if (!isPlainObject(value)
      || typeof value.signal !== "function"
      || typeof value.isGone !== "function") {
    throw probeError(PROBE_ERROR_CODES.INVALID_REQUEST);
  }
  if (value.dispose !== undefined && typeof value.dispose !== "function") {
    throw probeError(PROBE_ERROR_CODES.INVALID_REQUEST);
  }
}

export function createNativeProcessLifecycle(child) {
  const pid = Number.isSafeInteger(child?.pid) ? child.pid : null;
  return Object.freeze({
    signal(signal) {
      if (pid !== null && process.platform !== "win32") {
        try {
          process.kill(-pid, signal);
          return true;
        } catch {
          return false;
        }
      }
      try {
        return child?.kill?.(signal) !== false;
      } catch {
        return false;
      }
    },
    isGone() {
      return processGroupGone(child);
    }
  });
}

function createUnownedProcessLifecycle(child) {
  return Object.freeze({
    signal(signal) {
      try {
        return child?.kill?.(signal) !== false;
      } catch {
        return false;
      }
    },
    isGone() {
      // An injected spawn has no authority to claim an OS process group. Its
      // caller must provide the explicit code-owned test lifecycle seam.
      return false;
    }
  });
}

export function createCodeOwnedTestProcessLifecycle(child) {
  if (child === null || typeof child !== "object" || typeof child.kill !== "function") {
    throw probeError(PROBE_ERROR_CODES.INVALID_REQUEST);
  }
  let closeObserved = false;
  const onClose = () => {
    closeObserved = true;
  };
  child.once?.("close", onClose);
  return Object.freeze({
    signal(signal) {
      try {
        return child.kill(signal) !== false;
      } catch {
        return false;
      }
    },
    isGone() {
      return closeObserved && leaderExited(child);
    },
    dispose() {
      child.off?.("close", onClose);
    }
  });
}

const SAFE_NOTIFICATION_METHODS = new Set([
  "thread/started",
  "thread/status/changed",
  "turn/started",
  "turn/plan/updated",
  "item/started",
  "item/completed",
  "item/agentMessage/delta",
  "item/reasoning/summaryTextDelta",
  "item/reasoning/summaryPartAdded",
  "item/reasoning/textDelta",
  "thread/tokenUsage/updated",
  "account/rateLimits/updated",
  "warning"
]);
const EFFECTFUL_NOTIFICATION_PREFIXES = [
  "item/commandExecution",
  "item/fileChange",
  "item/mcpToolCall",
  "item/permissions",
  "command/",
  "process/"
];
const THREAD_ITEM_REQUIRED_FIELDS = Object.freeze({
  userMessage: ["content"],
  hookPrompt: ["fragments"],
  agentMessage: ["text"],
  plan: ["text"],
  reasoning: [],
  sleep: ["durationMs"],
  contextCompaction: []
});
const THREAD_ACTIVE_FLAGS = new Set(["waitingOnApproval", "waitingOnUserInput"]);
const THREAD_STATUS_TYPES = new Set(["notLoaded", "idle", "systemError", "active"]);
const TURN_ITEMS_VIEW_VALUES = new Set(["notLoaded", "summary", "full"]);
const TURN_PLAN_STEP_STATUS_VALUES = new Set(["pending", "inProgress", "completed"]);
const RATE_LIMIT_PLAN_TYPES = new Set([
  "free",
  "go",
  "plus",
  "pro",
  "prolite",
  "team",
  "self_serve_business_usage_based",
  "business",
  "ent26",
  "enterprise_cbp_usage_based",
  "enterprise",
  "edu",
  "unknown"
]);
const RATE_LIMIT_REACHED_TYPES = new Set([
  "rate_limit_reached",
  "workspace_owner_credits_depleted",
  "workspace_member_credits_depleted",
  "workspace_owner_usage_limit_reached",
  "workspace_member_usage_limit_reached"
]);

class JsonRpcAppServer {
  #child;
  #deadline;
  #signal;
  #processLifecycle;
  #abortHandler;
  #onServerRequest;
  #onServerRequestResolved;
  #processGeneration;
  #pending = new Map();
  #pendingWrites = new Set();
  #lineBuffer = Buffer.alloc(0);
  #requestNumber = 0;
  #closed = false;
  #stopping = false;
  #closePromise;
  #fatalError;
  #stdoutObserved = false;
  #stderrObserved = false;
  #stdoutBytes = 0;
  #stderrBytes = 0;
  #eventCount = 0;
  #outputOverflow = false;
  #serverRequests = [];
  #notifications = [];
  #respondedRequestKeys = new Set();
  #waitForUserInput;
  #waitForCompletion;

  constructor({ child, deadline, onServerRequest, onServerRequestResolved, processGeneration, signal, processLifecycle }) {
    this.#child = child;
    this.#deadline = deadline;
    this.#signal = signal;
    this.#processLifecycle = processLifecycle;
    this.#onServerRequest = onServerRequest;
    this.#onServerRequestResolved = onServerRequestResolved;
    this.#processGeneration = processGeneration;
    this.#abortHandler = () => this.#latchFatal(PROBE_ERROR_CODES.CANCELLED);
    if (signal?.addEventListener instanceof Function) {
      signal.addEventListener("abort", this.#abortHandler, { once: true });
    }
    this.#attach();
    if (signal?.aborted) {
      this.#abortHandler();
    }
  }

  async initialize(deadline = this.#deadline) {
    await this.request(CODEX_APP_SERVER_METHODS.initialize, {
      clientInfo: {
        name: "jarvis-phase9b-codex-restart-probe",
        title: "Jarvis Phase 9B Probe",
        version: "0.1.0"
      },
      capabilities: { experimentalApi: false, requestAttestation: false }
    }, deadline);
    await this.notify(CODEX_APP_SERVER_METHODS.initialized, null, deadline);
  }

  async request(method, params, deadline = this.#deadline, beforeWrite = undefined) {
    this.#assertWritable(deadline);
    if (!(deadline?.remaining instanceof Function)) {
      throw probeError(PROBE_ERROR_CODES.INVALID_REQUEST);
    }
    if (beforeWrite !== undefined && typeof beforeWrite !== "function") {
      throw probeError(PROBE_ERROR_CODES.INVALID_REQUEST);
    }
    if (![CODEX_APP_SERVER_METHODS.initialize,
      CODEX_APP_SERVER_METHODS.threadStart,
      CODEX_APP_SERVER_METHODS.threadResume,
      CODEX_APP_SERVER_METHODS.threadRead,
      CODEX_APP_SERVER_METHODS.turnStart].includes(method)) {
      throw probeError(PROBE_ERROR_CODES.INVALID_REQUEST);
    }
    const id = ++this.#requestNumber;
    const key = protocolIdKey(id);
    let responseSettled = false;
    let responseRejected = false;
    let responseValue;
    const response = new Promise((resolvePromise, rejectPromise) => {
      this.#pending.set(key, {
        resolve: (value) => {
          if (responseSettled) {
            return;
          }
          responseSettled = true;
          responseValue = value;
          resolvePromise(value);
        },
        reject: (error) => {
          if (responseSettled) {
            return;
          }
          responseSettled = true;
          responseRejected = true;
          rejectPromise(error);
        }
      });
    });
    // A fatal parser/child event can reject this promise before the write
    // callback settles. Keep a rejection handler attached for that window so
    // the process boundary never produces an unhandled rejection.
    void response.catch(() => undefined);
    try {
      beforeWrite?.();
      await this.#write({ id, method, params }, deadline);
    } catch (error) {
      this.#pending.delete(key);
      if (responseSettled && !responseRejected) {
        return responseValue;
      }
      throw error;
    }
    const timeoutMs = Math.floor(deadline.remaining());
    if (timeoutMs <= 0) {
      this.#pending.delete(key);
      throw probeError(PROBE_ERROR_CODES.DEADLINE_EXCEEDED);
    }
    try {
      return await raceTimeout(response, timeoutMs, PROBE_ERROR_CODES.PROTOCOL_TIMEOUT);
    } finally {
      this.#pending.delete(key);
    }
  }

  async notify(method, params, deadline = this.#deadline) {
    await this.#write({ method, params }, deadline);
  }

  async respond(requestId, result) {
    const key = protocolIdKey(requestId);
    const request = this.#serverRequests.find((candidate) => candidate.key === key);
    if (request === undefined) {
      throw probeError(PROBE_ERROR_CODES.UNSEEN_REQUEST);
    }
    if (request.resolved) {
      throw probeError(PROBE_ERROR_CODES.REQUEST_ALREADY_RESOLVED);
    }
    if (this.#respondedRequestKeys.has(key) || request.responded) {
      throw probeError(PROBE_ERROR_CODES.DUPLICATE_SERVER_REQUEST);
    }
    request.responded = true;
    this.#respondedRequestKeys.add(key);
    await this.#write({ id: requestId, result }, this.#deadline);
  }

  async waitForUserInput(deadline = this.#deadline) {
    this.#assertReadable(deadline);
    const timeoutMs = Math.floor(deadline.remaining());
    if (timeoutMs <= 0) {
      throw probeError(PROBE_ERROR_CODES.PROTOCOL_TIMEOUT);
    }
    if (this.#serverRequests.some((request) => request.method === CODEX_APP_SERVER_METHODS.requestUserInput)) {
      return;
    }
    const waiter = {};
    waiter.promise = new Promise((resolvePromise, rejectPromise) => {
      waiter.resolve = resolvePromise;
      waiter.reject = rejectPromise;
      this.#waitForUserInput = waiter;
    });
    try {
      await raceTimeout(waiter.promise, timeoutMs, PROBE_ERROR_CODES.PROTOCOL_TIMEOUT);
    } finally {
      if (this.#waitForUserInput === waiter) {
        this.#waitForUserInput = undefined;
      }
    }
  }

  async waitForTurnCompletion(threadId, turnId, deadline = this.#deadline) {
    this.#assertReadable(deadline);
    const timeoutMs = Math.floor(deadline.remaining());
    if (timeoutMs <= 0) {
      return false;
    }
    const current = this.#findTurnCompletion(threadId, turnId);
    if (current !== undefined) {
      return current.status === "completed" && !current.errorPresent;
    }
    try {
      return await raceTimeout(new Promise((resolvePromise, rejectPromise) => {
        this.#waitForCompletion = { threadId, turnId, resolve: resolvePromise, reject: rejectPromise };
      }), timeoutMs, PROBE_ERROR_CODES.PROTOCOL_TIMEOUT);
    } catch (error) {
      if (error?.code === PROBE_ERROR_CODES.PROTOCOL_TIMEOUT) {
        return false;
      }
      throw error;
    } finally {
      if (this.#waitForCompletion?.threadId === threadId
          && this.#waitForCompletion?.turnId === turnId) {
        this.#waitForCompletion = undefined;
      }
    }
  }

  hasTurnCompletion(threadId, turnId) {
    return this.#findTurnCompletion(threadId, turnId) !== undefined;
  }

  turnCompletionStatus(threadId, turnId) {
    return this.#findTurnCompletion(threadId, turnId)?.status ?? "unknown";
  }

  observedFacts(threadId, turnId) {
    const completion = this.#findTurnCompletion(threadId, turnId);
    return {
      turnCompletionObserved: completion !== undefined,
      turnCompletionStatus: completion?.status ?? "unknown",
      resolvedObserved: this.#serverRequests.some((request) =>
        request.resolved && request.params.threadId === threadId && request.params.turnId === turnId),
      fatalCode: this.#fatalError?.code
    };
  }

  assertHealthy() {
    throwIfAborted(this.#signal);
    if (this.#fatalError !== undefined) {
      throw this.#fatalError;
    }
    if (this.#closed || this.#stopping) {
      throw probeError(PROBE_ERROR_CODES.PROBE_RUNTIME_ERROR);
    }
  }

  async stop() {
    if (this.#closePromise !== undefined) {
      return await this.#closePromise;
    }
    this.#stopping = true;
    this.#rejectPending(PROBE_ERROR_CODES.CANCELLED);
    this.#removeAbortHandler();
    this.#closePromise = terminateProcess(this.#child, PROCESS_KILL_GRACE_MS, this.#processLifecycle)
      .then((termination) => {
        this.#closed = true;
        this.#processLifecycle.dispose?.();
        return {
          ...termination,
          streams: {
            stdout: { observed: this.#stdoutObserved, suppressed: true },
            stderr: { observed: this.#stderrObserved, suppressed: true }
          }
        };
      }, (error) => {
        this.#processLifecycle.dispose?.();
        throw error;
      });
    return await this.#closePromise;
  }

  #attach() {
    this.#child?.stdout?.on?.("data", (chunk) => {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
      this.#stdoutObserved ||= bytes.length > 0;
      this.#stdoutBytes += bytes.length;
      if (this.#stdoutBytes > MAX_CAPTURE_BYTES) {
        this.#latchFatal(PROBE_ERROR_CODES.OUTPUT_REJECTED);
        return;
      }
      this.#ingest(bytes);
    });
    this.#child?.stderr?.on?.("data", (chunk) => {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
      this.#stderrObserved ||= bytes.length > 0;
      this.#stderrBytes += bytes.length;
      if (this.#stderrBytes > MAX_CAPTURE_BYTES) {
        this.#latchFatal(PROBE_ERROR_CODES.OUTPUT_REJECTED);
      }
    });
    this.#child?.once?.("error", () => {
      if (!this.#stopping) {
        this.#latchFatal(PROBE_ERROR_CODES.PROBE_RUNTIME_ERROR);
      }
    });
    this.#child?.once?.("close", () => {
      this.#closed = true;
      if (!this.#stopping) {
        this.#latchFatal(PROBE_ERROR_CODES.PROBE_RUNTIME_ERROR);
      } else {
        this.#rejectPending(PROBE_ERROR_CODES.CANCELLED);
      }
    });
  }

  #ingest(bytes) {
    if (this.#fatalError !== undefined || this.#outputOverflow) {
      return;
    }
    this.#lineBuffer = Buffer.concat([this.#lineBuffer, bytes]);
    if (this.#lineBuffer.length > MAX_RPC_LINE_BYTES) {
      this.#outputOverflow = true;
      this.#latchFatal(PROBE_ERROR_CODES.OUTPUT_REJECTED);
      return;
    }
    while (true) {
      const index = this.#lineBuffer.indexOf(0x0a);
      if (index < 0) {
        return;
      }
      const lineBytes = this.#lineBuffer.subarray(0, index);
      this.#lineBuffer = this.#lineBuffer.subarray(index + 1);
      const line = lineBytes.toString("utf8").replace(/\r$/, "");
      if (lineBytes.length > MAX_RPC_LINE_BYTES || line.length === 0) {
        this.#latchFatal(PROBE_ERROR_CODES.PROTOCOL_INVALID);
        return;
      }
      let value;
      try {
        value = JSON.parse(line);
        this.#handleMessage(value);
      } catch (error) {
        this.#latchFatal(ERROR_VALUES.has(error?.code) ? error.code : PROBE_ERROR_CODES.PROTOCOL_INVALID);
        return;
      }
      if (this.#fatalError !== undefined) {
        return;
      }
    }
  }

  #handleMessage(value) {
    if (!isPlainObject(value)) {
      throw probeError(PROBE_ERROR_CODES.PROTOCOL_INVALID);
    }
    this.#eventCount += 1;
    if (this.#eventCount > MAX_PROTOCOL_EVENTS) {
      throw probeError(PROBE_ERROR_CODES.OUTPUT_REJECTED);
    }
    const hasId = Object.hasOwn(value, "id");
    const hasResult = Object.hasOwn(value, "result");
    const hasError = Object.hasOwn(value, "error");
    if (hasId && (hasResult || hasError)) {
      if (hasResult && hasError) {
        throw probeError(PROBE_ERROR_CODES.PROTOCOL_INVALID);
      }
      const pending = this.#pending.get(protocolIdKey(value.id));
      if (pending === undefined) {
        throw probeError(PROBE_ERROR_CODES.PROTOCOL_INVALID);
      }
      if (hasError) {
        pending.reject(probeError(PROBE_ERROR_CODES.PROBE_RUNTIME_ERROR));
      } else {
        pending.resolve(value.result);
      }
      return;
    }
    if (hasId && typeof value.method === "string" && Object.hasOwn(value, "params")) {
      if (value.method !== CODEX_APP_SERVER_METHODS.requestUserInput) {
        throw probeError(EFFECTFUL_NOTIFICATION_PREFIXES.some((prefix) => value.method.startsWith(prefix))
          ? PROBE_ERROR_CODES.EFFECTFUL_REQUEST_REJECTED
          : PROBE_ERROR_CODES.UNSUPPORTED_REQUEST);
      }
      const params = normalizeUserInputParams(value.params);
      assertControlledQuestions(params.questions);
      const request = {
        requestId: value.id,
        key: protocolIdKey(value.id),
        method: value.method,
        params,
        resolved: false,
        responded: false
      };
      this.#serverRequests.push(request);
      this.#onServerRequest?.(request);
      if (this.#waitForUserInput !== undefined) {
        const waiter = this.#waitForUserInput;
        this.#waitForUserInput = undefined;
        waiter.resolve();
      }
      return;
    }
    if (typeof value.method === "string") {
      const notification = parseNotification(
        value.method,
        value.params,
        this.#serverRequests.at(-1)?.params
      );
      if (notification.method === CODEX_APP_SERVER_METHODS.serverRequestResolved) {
        const request = this.#serverRequests.find((candidate) =>
          candidate.key === protocolIdKey(notification.requestId));
        if (request === undefined) {
          throw probeError(PROBE_ERROR_CODES.UNSEEN_REQUEST);
        }
        if (notification.threadId !== request.params.threadId) {
          throw probeError(PROBE_ERROR_CODES.REISSUED_REQUEST_MISMATCH);
        }
        if (request.resolved) {
          throw probeError(PROBE_ERROR_CODES.DUPLICATE_SERVER_REQUEST);
        }
        request.resolved = true;
        this.#onServerRequestResolved?.({
          requestId: request.requestId,
          threadId: notification.threadId,
          turnId: request.params.turnId,
          ...(this.#processGeneration === undefined ? {} : { processGeneration: this.#processGeneration })
        });
      }
      this.#notifications.push(notification);
      if (notification.method === CODEX_APP_SERVER_METHODS.turnCompleted
          && this.#waitForCompletion !== undefined
          && notification.threadId === this.#waitForCompletion.threadId
          && notification.turnId === this.#waitForCompletion.turnId) {
        const waiter = this.#waitForCompletion;
        this.#waitForCompletion = undefined;
        waiter.resolve(notification.status === "completed" && !notification.errorPresent);
      }
      return;
    }
    throw probeError(PROBE_ERROR_CODES.PROTOCOL_INVALID);
  }

  async #write(value, deadline = this.#deadline) {
    this.#assertWritable(deadline);
    const serialized = JSON.stringify(value);
    if (typeof serialized !== "string" || Buffer.byteLength(serialized, "utf8") > MAX_RPC_LINE_BYTES) {
      throw probeError(PROBE_ERROR_CODES.OUTPUT_REJECTED);
    }
    const stdin = this.#child?.stdin;
    if (stdin === undefined || stdin.destroyed || typeof stdin.write !== "function") {
      throw probeError(PROBE_ERROR_CODES.PROBE_RUNTIME_ERROR);
    }
    const timeoutMs = Math.floor(deadline.remaining());
    if (timeoutMs <= 0) {
      throw probeError(PROBE_ERROR_CODES.DEADLINE_EXCEEDED);
    }
    await new Promise((resolvePromise, rejectPromise) => {
      let settled = false;
      let timer;
      const finish = (callback) => (value) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        this.#pendingWrites.delete(waiter);
        callback(value);
      };
      const resolveWrite = finish(resolvePromise);
      const rejectWrite = finish(rejectPromise);
      const waiter = {
        reject: (error) => rejectWrite(error)
      };
      this.#pendingWrites.add(waiter);
      timer = setTimeout(
        () => rejectWrite(probeError(PROBE_ERROR_CODES.DEADLINE_EXCEEDED)),
        timeoutMs
      );
      try {
        stdin.write(`${serialized}\n`, (error) => error === undefined || error === null
          ? resolveWrite()
          : rejectWrite(probeError(PROBE_ERROR_CODES.PROBE_RUNTIME_ERROR)));
      } catch {
        rejectWrite(probeError(PROBE_ERROR_CODES.PROBE_RUNTIME_ERROR));
      }
    });
  }

  #findTurnCompletion(threadId, turnId) {
    return this.#notifications.find((notification) =>
      notification.method === CODEX_APP_SERVER_METHODS.turnCompleted
      && notification.threadId === threadId
      && notification.turnId === turnId);
  }

  #assertReadable(deadline) {
    throwIfAborted(this.#signal);
    if (this.#fatalError !== undefined) {
      throw this.#fatalError;
    }
    if (this.#closed || this.#stopping || deadline?.expired?.()) {
      throw probeError(PROBE_ERROR_CODES.DEADLINE_EXCEEDED);
    }
  }

  #assertWritable(deadline) {
    this.#assertReadable(deadline);
  }

  #rejectPending(code) {
    const error = probeError(code);
    for (const pendingWrite of [...this.#pendingWrites]) {
      pendingWrite.reject(error);
    }
    for (const pending of this.#pending.values()) {
      pending.reject(error);
    }
    this.#pending.clear();
    this.#waitForUserInput?.reject?.(error);
    this.#waitForUserInput = undefined;
    this.#waitForCompletion?.reject?.(error);
    this.#waitForCompletion = undefined;
  }

  #latchFatal(code) {
    if (this.#fatalError !== undefined) {
      return;
    }
    this.#fatalError = probeError(code);
    this.#outputOverflow ||= code === PROBE_ERROR_CODES.OUTPUT_REJECTED;
    this.#rejectPending(code);
  }

  #removeAbortHandler() {
    if (this.#abortHandler !== undefined && this.#signal?.removeEventListener instanceof Function) {
      this.#signal.removeEventListener("abort", this.#abortHandler);
    }
    this.#abortHandler = undefined;
  }
}

const CONTROLLED_TASK_PROMPT = "Before any other action, use the native request_user_input tool to ask exactly one question with id choice, isOther false, isSecret false, and exactly the options alpha followed by beta. Do not read files, write files, run commands, access the network, request approval, or call another tool. After the answer, finish with a short completion.";
const CONTROLLED_CONTINUATION_PROMPT = "Continue only the one pending user-input interaction for this task. Do not read or write files, run commands, access the network, request approval, or call another tool. After the bounded answer is available, finish.";

function boundaryRequestIdentity(boundary) {
  // The registry data is retained in the trusted process boundary and never
  // enters the result projection.
  return boundary.currentRequestIdentity();
}

function boundaryRequestParameters(boundary) {
  return boundary.currentRequestParameters() ?? { questions: [] };
}

function assertProbeRunGates({ securityRemediationStatus, offlineGatesPassed }) {
  if (securityRemediationStatus !== "RESOLVED_NO_REUSABLE_CREDENTIAL_EXPOSURE") {
    throw probeError(PROBE_ERROR_CODES.SECURITY_GATE_REQUIRED);
  }
  if (offlineGatesPassed !== true) {
    throw probeError(PROBE_ERROR_CODES.OFFLINE_GATES_REQUIRED);
  }
}

function throwIfAborted(signal) {
  if (signal?.aborted) {
    throw probeError(PROBE_ERROR_CODES.CANCELLED);
  }
}

function buildContinuationPrompt({ taskId, questionId, answer }) {
  if (!INTERNAL_UUID_PATTERN.test(taskId ?? "") || questionId !== "choice" || !["alpha", "beta"].includes(answer)) {
    throw probeError(PROBE_ERROR_CODES.INVALID_REQUEST);
  }
  return `${CONTROLLED_CONTINUATION_PROMPT} Task ${taskId}; question ${questionId}; answer ${answer}.`;
}

function extractProfileId(response) {
  if (!isPlainObject(response) || !isPlainObject(response.activePermissionProfile)
      || typeof response.activePermissionProfile.id !== "string") {
    throw probeError(PROBE_ERROR_CODES.PERMISSION_PROFILE_UNCONFIRMED);
  }
  return response.activePermissionProfile.id;
}

function extractProfileIdFromArgs(args) {
  const value = args.find((item) => item.startsWith("default_permissions="));
  const match = value?.match(/^default_permissions="([^"]+)"$/);
  if (!match) {
    throw probeError(PROBE_ERROR_CODES.INVALID_PERMISSION_PROFILE);
  }
  return match[1];
}

function extractThreadId(response) {
  const thread = response?.thread;
  if (!isPlainObject(thread) || typeof thread.id !== "string" || thread.id.length === 0) {
    throw probeError(PROBE_ERROR_CODES.PROTOCOL_INVALID);
  }
  return thread.id;
}

function extractTurnId(response) {
  const turn = response?.turn;
  if (!isPlainObject(turn) || typeof turn.id !== "string" || turn.id.length === 0) {
    throw probeError(PROBE_ERROR_CODES.PROTOCOL_INVALID);
  }
  return turn.id;
}

function parseNotification(method, params, currentRequest = undefined) {
  if (method === "error") {
    throw probeError(PROBE_ERROR_CODES.PROBE_RUNTIME_ERROR);
  }
  if (method === CODEX_APP_SERVER_METHODS.serverRequestResolved) {
    return parseResolvedNotification(params);
  }
  if (method === CODEX_APP_SERVER_METHODS.turnCompleted || method === "turn/started") {
    const parsed = parseTurnNotification(params, currentRequest);
    return {
      method,
      threadId: parsed.threadId,
      turnId: parsed.turnId,
      status: parsed.status,
      errorPresent: parsed.errorPresent
    };
  }
  if (method === "thread/status/changed") {
    assertProtocolExactKeys(params, ["status", "threadId"]);
    const threadId = protocolStringId(params.threadId);
    validateThreadStatus(params.status);
    return { method, threadId };
  }
  if (method === "thread/started") {
    assertProtocolExactKeys(params, ["thread"]);
    assertProtocolThread(params.thread);
    return { method };
  }
  if (method === "turn/plan/updated") {
    assertProtocolExactKeys(params, ["plan", "threadId", "turnId"], ["explanation"]);
    const threadId = protocolStringId(params.threadId);
    const turnId = protocolStringId(params.turnId);
    if (!Array.isArray(params.plan) || params.plan.length > MAX_PROTOCOL_EVENTS) {
      throw probeError(PROBE_ERROR_CODES.PROTOCOL_INVALID);
    }
    for (const step of params.plan) {
      assertProtocolExactKeys(step, ["status", "step"]);
      assertProtocolEnum(step.status, TURN_PLAN_STEP_STATUS_VALUES);
      assertProtocolText(step.step);
    }
    if (params.explanation !== undefined && params.explanation !== null) {
      assertProtocolText(params.explanation);
    }
    return { method, threadId, turnId };
  }
  if (method === "item/started" || method === "item/completed") {
    const timestamp = method === "item/started" ? "startedAtMs" : "completedAtMs";
    assertProtocolExactKeys(params, ["item", timestamp, "threadId", "turnId"]);
    const threadId = protocolStringId(params.threadId);
    const turnId = protocolStringId(params.turnId);
    if (currentRequest !== undefined
        && (currentRequest.threadId !== threadId || currentRequest.turnId !== turnId)) {
      throw probeError(PROBE_ERROR_CODES.REISSUED_REQUEST_MISMATCH);
    }
    assertProtocolTimestamp(params[timestamp]);
    validateThreadItem(params.item, {
      threadId,
      turnId,
      itemId: currentRequest?.itemId ?? params.item.id,
      questionIds: currentRequest?.questions?.map((question) => question.id)
    });
    return { method, threadId, turnId };
  }
  if (method === "item/agentMessage/delta") {
    assertProtocolExactKeys(params, ["delta", "itemId", "threadId", "turnId"]);
    assertProtocolText(params.delta);
    return {
      method,
      itemId: protocolStringId(params.itemId),
      threadId: protocolStringId(params.threadId),
      turnId: protocolStringId(params.turnId)
    };
  }
  if (method === "item/reasoning/summaryTextDelta") {
    assertProtocolExactKeys(params, ["delta", "itemId", "summaryIndex", "threadId", "turnId"]);
    assertProtocolText(params.delta);
    assertProtocolIndex(params.summaryIndex);
    return {
      method,
      itemId: protocolStringId(params.itemId),
      threadId: protocolStringId(params.threadId),
      turnId: protocolStringId(params.turnId)
    };
  }
  if (method === CODEX_APP_SERVER_METHODS.reasoningSummaryPartAdded) {
    assertProtocolExactKeys(params, ["itemId", "summaryIndex", "threadId", "turnId"]);
    assertProtocolIndex(params.summaryIndex);
    return {
      method,
      itemId: protocolStringId(params.itemId),
      threadId: protocolStringId(params.threadId),
      turnId: protocolStringId(params.turnId)
    };
  }
  if (method === CODEX_APP_SERVER_METHODS.reasoningTextDelta) {
    assertProtocolExactKeys(params, ["contentIndex", "delta", "itemId", "threadId", "turnId"]);
    assertProtocolIndex(params.contentIndex);
    assertProtocolText(params.delta);
    return {
      method,
      itemId: protocolStringId(params.itemId),
      threadId: protocolStringId(params.threadId),
      turnId: protocolStringId(params.turnId)
    };
  }
  if (method === CODEX_APP_SERVER_METHODS.tokenUsageUpdated) {
    assertProtocolExactKeys(params, ["threadId", "tokenUsage", "turnId"]);
    const threadId = protocolStringId(params.threadId);
    const turnId = protocolStringId(params.turnId);
    validateTokenUsage(params.tokenUsage);
    return { method, threadId, turnId };
  }
  if (method === CODEX_APP_SERVER_METHODS.accountRateLimitsUpdated) {
    assertProtocolExactKeys(params, ["rateLimits"]);
    validateRateLimits(params.rateLimits);
    return { method };
  }
  if (method === "warning") {
    assertProtocolExactKeys(params, ["message"], ["threadId"]);
    assertProtocolText(params.message);
    if (params.threadId !== undefined && params.threadId !== null) {
      protocolStringId(params.threadId);
    }
    return { method };
  }
  if (SAFE_NOTIFICATION_METHODS.has(method)) {
    return { method };
  }
  throw probeError(EFFECTFUL_NOTIFICATION_PREFIXES.some((prefix) => method.startsWith(prefix))
    ? PROBE_ERROR_CODES.EFFECTFUL_REQUEST_REJECTED
    : PROBE_ERROR_CODES.UNSUPPORTED_REQUEST);
}

function parseResolvedNotification(params) {
  assertProtocolExactKeys(params, ["requestId", "threadId"]);
  if (typeof params.requestId === "string" && containsSecretLike(params.requestId)) {
    throw probeError(PROBE_ERROR_CODES.PROTOCOL_INVALID);
  }
  protocolIdKey(params.requestId);
  return {
    method: CODEX_APP_SERVER_METHODS.serverRequestResolved,
    requestId: params.requestId,
    threadId: protocolStringId(params.threadId)
  };
}

function parseTurnNotification(params, currentRequest = undefined) {
  assertProtocolExactKeys(params, ["threadId", "turn"]);
  const threadId = protocolStringId(params.threadId);
  const turn = validateTurn(params.turn, threadId, currentRequest);
  if (currentRequest !== undefined
      && (currentRequest.threadId !== threadId || currentRequest.turnId !== turn.id)) {
    throw probeError(PROBE_ERROR_CODES.REISSUED_REQUEST_MISMATCH);
  }
  return {
    threadId,
    turnId: turn.id,
    status: turn.status,
    errorPresent: turn.errorPresent
  };
}

function validateTurn(turn, threadId, expectedRequest = undefined) {
  assertProtocolExactKeys(turn, ["id", "items", "status"], [
    "completedAt",
    "durationMs",
    "error",
    "itemsView",
    "startedAt"
  ]);
  const id = protocolStringId(turn.id);
  assertProtocolEnum(turn.status, NATIVE_TURN_STATUS_VALUES);
  if (!Array.isArray(turn.items) || turn.items.length > MAX_PROTOCOL_EVENTS) {
    throw probeError(PROBE_ERROR_CODES.PROTOCOL_INVALID);
  }
  if (turn.itemsView !== undefined) {
    assertProtocolEnum(turn.itemsView, TURN_ITEMS_VIEW_VALUES);
  }
  for (const timestamp of ["completedAt", "durationMs", "startedAt"]) {
    if (turn[timestamp] !== undefined && turn[timestamp] !== null) {
      assertProtocolTimestamp(turn[timestamp]);
    }
  }
  if (turn.error !== undefined && turn.error !== null && !isPlainObject(turn.error)) {
    throw probeError(PROBE_ERROR_CODES.PROTOCOL_INVALID);
  }
  for (const item of turn.items) {
    validateThreadItem(item, {
      threadId,
      turnId: id,
      itemId: expectedRequest?.itemId,
      questionIds: expectedRequest?.questions?.map((question) => question.id)
    });
  }
  return { id, status: turn.status, errorPresent: turn.error !== undefined && turn.error !== null };
}

function validateThreadItem(item, identity = undefined) {
  assertProtocolPlainObject(item);
  if (!boundedText(item.id, MAX_ID_LENGTH) || containsSecretLike(item.id)
      || !boundedText(item.type, 100)) {
    throw probeError(PROBE_ERROR_CODES.PROTOCOL_INVALID);
  }
  if (EFFECTFUL_HISTORY_ITEM_TYPES.has(item.type)) {
    if (item.type === "dynamicToolCall" && isControlledUserInputItem(item, identity) !== null) {
      return;
    }
    throw probeError(PROBE_ERROR_CODES.EFFECTFUL_REQUEST_REJECTED);
  }
  if (!SAFE_HISTORY_ITEM_TYPES.has(item.type)) {
    throw probeError(PROBE_ERROR_CODES.PROTOCOL_INVALID);
  }
  const required = THREAD_ITEM_REQUIRED_FIELDS[item.type];
  if (required === undefined || required.some((key) => !Object.hasOwn(item, key))) {
    throw probeError(PROBE_ERROR_CODES.PROTOCOL_INVALID);
  }
  if (item.type === "userMessage" && !Array.isArray(item.content)) {
    throw probeError(PROBE_ERROR_CODES.PROTOCOL_INVALID);
  }
  if (item.type === "hookPrompt" && !Array.isArray(item.fragments)) {
    throw probeError(PROBE_ERROR_CODES.PROTOCOL_INVALID);
  }
  if ((item.type === "agentMessage" || item.type === "plan") && typeof item.text !== "string") {
    throw probeError(PROBE_ERROR_CODES.PROTOCOL_INVALID);
  }
  if (item.type === "sleep") {
    assertProtocolTimestamp(item.durationMs);
  }
}

function isControlledUserInputItem(item, identity = undefined) {
  if (!isPlainObject(item) || item.type !== "dynamicToolCall"
      || item.tool !== "request_user_input"
      || !["inProgress", "completed"].includes(item.status)
      || !isPlainObject(item.arguments)) {
    return null;
  }
  if (identity?.itemId !== undefined && item.id !== identity.itemId) {
    return null;
  }
  try {
    let questions;
    if (Object.keys(item.arguments).length === 1 && Object.hasOwn(item.arguments, "questions")) {
      questions = normalizeUserInputQuestions(item.arguments.questions);
      if (identity?.threadId === undefined || identity?.turnId === undefined) {
        return null;
      }
    } else {
      const normalized = normalizeUserInputParams(item.arguments);
      if (identity !== undefined
          && (normalized.threadId !== identity.threadId
            || normalized.turnId !== identity.turnId
            || normalized.itemId !== item.id)) {
        return null;
      }
      questions = normalized.questions;
    }
    assertControlledQuestions(questions);
    if (identity?.questionIds !== undefined
        && !sameKeys(questions.map((question) => question.id), identity.questionIds)) {
      return null;
    }
    return questions;
  } catch {
    return null;
  }
}

function validateThreadStatus(status) {
  assertProtocolPlainObject(status);
  if (!THREAD_STATUS_TYPES.has(status.type)) {
    throw probeError(PROBE_ERROR_CODES.PROTOCOL_INVALID);
  }
  if (status.type === "active") {
    assertProtocolExactKeys(status, ["activeFlags", "type"]);
    if (!Array.isArray(status.activeFlags) || status.activeFlags.length > MAX_PROTOCOL_EVENTS
        || status.activeFlags.some((flag) => !THREAD_ACTIVE_FLAGS.has(flag))) {
      throw probeError(PROBE_ERROR_CODES.PROTOCOL_INVALID);
    }
  } else {
    assertProtocolExactKeys(status, ["type"]);
  }
}

function validateTokenUsage(value) {
  assertProtocolExactKeys(value, ["last", "total"], ["modelContextWindow"]);
  for (const breakdown of [value.last, value.total]) {
    assertProtocolExactKeys(breakdown, [
      "cachedInputTokens",
      "inputTokens",
      "outputTokens",
      "reasoningOutputTokens",
      "totalTokens"
    ], ["cacheWriteInputTokens"]);
    for (const key of Object.keys(breakdown)) {
      assertProtocolCount(breakdown[key]);
    }
  }
  if (value.modelContextWindow !== undefined && value.modelContextWindow !== null) {
    assertProtocolCount(value.modelContextWindow);
  }
}

function validateRateLimits(value) {
  assertProtocolExactKeys(value, [], [
    "credits",
    "individualLimit",
    "limitId",
    "limitName",
    "planType",
    "primary",
    "rateLimitReachedType",
    "secondary",
    "spendControlReached"
  ]);
  assertNullableProtocolString(value.limitId);
  assertNullableProtocolString(value.limitName);
  assertNullableProtocolEnum(value.planType, RATE_LIMIT_PLAN_TYPES);
  assertNullableProtocolEnum(value.rateLimitReachedType, RATE_LIMIT_REACHED_TYPES);
  if (value.spendControlReached !== undefined
      && value.spendControlReached !== null
      && typeof value.spendControlReached !== "boolean") {
    throw probeError(PROBE_ERROR_CODES.PROTOCOL_INVALID);
  }
  validateCreditsSnapshot(value.credits);
  validateSpendLimitSnapshot(value.individualLimit);
  validateRateLimitWindow(value.primary);
  validateRateLimitWindow(value.secondary);
}

function validateCreditsSnapshot(value) {
  if (value === undefined || value === null) {
    return;
  }
  assertProtocolExactKeys(value, ["hasCredits", "unlimited"], ["balance"]);
  if (typeof value.hasCredits !== "boolean" || typeof value.unlimited !== "boolean") {
    throw probeError(PROBE_ERROR_CODES.PROTOCOL_INVALID);
  }
  assertNullableProtocolString(value.balance);
}

function validateSpendLimitSnapshot(value) {
  if (value === undefined || value === null) {
    return;
  }
  assertProtocolExactKeys(value, ["limit", "remainingPercent", "resetsAt", "used"]);
  assertProtocolText(value.limit);
  assertProtocolText(value.used);
  assertProtocolCount(value.remainingPercent, 100);
  assertProtocolCount(value.resetsAt);
}

function validateRateLimitWindow(value) {
  if (value === undefined || value === null) {
    return;
  }
  assertProtocolExactKeys(value, ["usedPercent"], ["resetsAt", "windowDurationMins"]);
  assertProtocolCount(value.usedPercent, 100);
  if (value.resetsAt !== undefined && value.resetsAt !== null) {
    assertProtocolCount(value.resetsAt);
  }
  if (value.windowDurationMins !== undefined && value.windowDurationMins !== null) {
    assertProtocolCount(value.windowDurationMins);
  }
}

function assertProtocolPlainObject(value) {
  assertPlainObject(value, PROBE_ERROR_CODES.PROTOCOL_INVALID);
}

function assertProtocolExactKeys(value, required, optional = []) {
  assertProtocolPlainObject(value);
  assertExactKeys(value, required, optional, PROBE_ERROR_CODES.PROTOCOL_INVALID);
}

function assertProtocolEnum(value, values) {
  if (!values.has(value)) {
    throw probeError(PROBE_ERROR_CODES.PROTOCOL_INVALID);
  }
}

function assertProtocolTimestamp(value) {
  assertProtocolCount(value);
}

function assertProtocolIndex(value) {
  assertProtocolCount(value);
}

function assertProtocolCount(value, max = Number.MAX_SAFE_INTEGER) {
  if (!Number.isSafeInteger(value) || value < 0 || value > max) {
    throw probeError(PROBE_ERROR_CODES.PROTOCOL_INVALID);
  }
}

function assertProtocolText(value) {
  if (typeof value !== "string" || value.length > MAX_TEXT_LENGTH || containsControlCharacters(value)) {
    throw probeError(PROBE_ERROR_CODES.PROTOCOL_INVALID);
  }
}

function protocolStringId(value) {
  if (!boundedText(value, MAX_ID_LENGTH) || containsSecretLike(value)) {
    throw probeError(PROBE_ERROR_CODES.PROTOCOL_INVALID);
  }
  return value;
}

function assertNullableProtocolString(value) {
  if (value !== undefined && value !== null) {
    assertProtocolText(value);
  }
}

function assertNullableProtocolEnum(value, values) {
  if (value !== undefined && value !== null) {
    assertProtocolEnum(value, values);
  }
}

function assertProtocolThread(value) {
  assertProtocolPlainObject(value);
  if (!boundedText(value.id, MAX_ID_LENGTH) || containsSecretLike(value.id)) {
    throw probeError(PROBE_ERROR_CODES.PROTOCOL_INVALID);
  }
}

function normalizeUserInputParams(params) {
  assertPlainObject(params, PROBE_ERROR_CODES.INVALID_REQUEST);
  assertExactKeys(params, ["itemId", "questions", "threadId", "turnId"], ["autoResolutionMs"]);
  const itemId = normalizeProtocolId(params.itemId, PROBE_ERROR_CODES.INVALID_REQUEST);
  const threadId = normalizeProtocolId(params.threadId, PROBE_ERROR_CODES.INVALID_REQUEST);
  const turnId = normalizeProtocolId(params.turnId, PROBE_ERROR_CODES.INVALID_REQUEST);
  const questions = normalizeUserInputQuestions(params.questions);
  if (params.autoResolutionMs !== undefined && params.autoResolutionMs !== null
      && (!Number.isSafeInteger(params.autoResolutionMs) || params.autoResolutionMs < 0 || params.autoResolutionMs > 86_400_000)) {
    throw probeError(PROBE_ERROR_CODES.INVALID_REQUEST);
  }
  return { itemId, threadId, turnId, questions, autoResolutionMs: params.autoResolutionMs ?? null };
}

function normalizeUserInputQuestions(value) {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_QUESTIONS) {
    throw probeError(PROBE_ERROR_CODES.INVALID_REQUEST);
  }
  const ids = new Set();
  return value.map((question) => {
    assertPlainObject(question, PROBE_ERROR_CODES.INVALID_REQUEST);
    assertExactKeys(question, ["header", "id", "question"], ["isOther", "isSecret", "options"]);
    if (!boundedText(question.header, 200)
        || !boundedText(question.id, 200)
        || !boundedText(question.question, MAX_TEXT_LENGTH)
        || ids.has(question.id)) {
      throw probeError(PROBE_ERROR_CODES.INVALID_REQUEST);
    }
    const header = question.header;
    const id = question.id;
    const text = question.question;
    ids.add(id);
    if (question.isOther !== undefined && typeof question.isOther !== "boolean") {
      throw probeError(PROBE_ERROR_CODES.INVALID_REQUEST);
    }
    if (question.isSecret === true) {
      throw probeError(PROBE_ERROR_CODES.SECRET_INPUT_REJECTED);
    }
    if (question.isSecret !== undefined && typeof question.isSecret !== "boolean") {
      throw probeError(PROBE_ERROR_CODES.INVALID_REQUEST);
    }
    let options = null;
    if (question.options !== undefined && question.options !== null) {
      if (!Array.isArray(question.options) || question.options.length > MAX_OPTIONS) {
        throw probeError(PROBE_ERROR_CODES.INVALID_REQUEST);
      }
      const labels = new Set();
      options = question.options.map((option) => {
        assertPlainObject(option, PROBE_ERROR_CODES.INVALID_REQUEST);
        assertExactKeys(option, ["description", "label"]);
        if (!boundedText(option.label, 200)
            || !boundedText(option.description, 2_000)
            || labels.has(option.label)) {
          throw probeError(PROBE_ERROR_CODES.INVALID_REQUEST);
        }
        const label = option.label;
        const description = option.description;
        labels.add(label);
        if (containsSecretLike(label) || containsSecretLike(description)) {
          throw probeError(PROBE_ERROR_CODES.SECRET_INPUT_REJECTED);
        }
        return { label, description };
      });
    }
    return {
      header,
      id,
      question: text,
      isOther: question.isOther === true,
      isSecret: false,
      options
    };
  });
}

function assertControlledQuestions(questions) {
  if (!Array.isArray(questions) || questions.length !== 1 || questions[0]?.id !== "choice") {
    throw probeError(PROBE_ERROR_CODES.INVALID_REQUEST);
  }
  if (questions[0].isOther !== false || questions[0].isSecret !== false) {
    throw probeError(PROBE_ERROR_CODES.INVALID_REQUEST);
  }
  const labels = questions[0].options?.map((option) => option.label) ?? [];
  if (labels.length !== 2 || labels[0] !== "alpha" || labels[1] !== "beta") {
    throw probeError(PROBE_ERROR_CODES.INVALID_REQUEST);
  }
}

function isPendingUserInputItem(item, pendingIdentity) {
  if (item.type !== "dynamicToolCall"
      || item.tool !== "request_user_input"
      || item.status !== "inProgress"
      || item.id !== pendingIdentity.itemId
      || !Array.isArray(pendingIdentity.questionIds)
      || !isPlainObject(item.arguments)) {
    return false;
  }
  let questions;
  try {
    if (Object.keys(item.arguments).length === 1 && Object.hasOwn(item.arguments, "questions")) {
      questions = normalizeUserInputQuestions(item.arguments.questions);
    } else {
      const normalized = normalizeUserInputParams(item.arguments);
      if (normalized.threadId !== pendingIdentity.threadId
          || normalized.turnId !== pendingIdentity.turnId
          || normalized.itemId !== pendingIdentity.itemId) {
        return false;
      }
      questions = normalized.questions;
    }
    assertControlledQuestions(questions);
  } catch {
    return false;
  }
  return sameKeys(questions.map((question) => question.id), pendingIdentity.questionIds);
}

function normalizeAnswers(answers, questions) {
  assertPlainObject(answers, PROBE_ERROR_CODES.ANSWER_INVALID);
  if (!sameKeys(answers, questions.map((question) => question.id))) {
    throw probeError(PROBE_ERROR_CODES.ANSWER_INVALID);
  }
  let total = 0;
  const normalized = {};
  for (const question of questions) {
    const answer = answers[question.id];
    assertPlainObject(answer, PROBE_ERROR_CODES.ANSWER_INVALID);
    assertExactKeys(answer, ["answers"]);
    if (!Array.isArray(answer.answers) || answer.answers.length < 1 || answer.answers.length > MAX_OPTIONS) {
      throw probeError(PROBE_ERROR_CODES.ANSWER_INVALID);
    }
    const allowedLabels = new Set((question.options ?? []).map((option) => option.label));
    const values = answer.answers.map((item) => {
      if (!boundedText(item, MAX_ANSWER_LENGTH) || containsSecretLike(item)
          || (allowedLabels.size > 0 && !question.isOther && !allowedLabels.has(item))) {
        throw probeError(PROBE_ERROR_CODES.ANSWER_INVALID);
      }
      total += item.length;
      if (total > MAX_TOTAL_ANSWER_LENGTH) {
        throw probeError(PROBE_ERROR_CODES.ANSWER_INVALID);
      }
      return item;
    });
    normalized[question.id] = { answers: values };
  }
  return normalized;
}

function projectCleanup(value) {
  assertPlainObject(value, PROBE_ERROR_CODES.OUTPUT_REJECTED);
  assertExactKeys(value, ["completed", "processGroupGone", "forcedKill"]);
  assertBoolean(value.completed);
  assertBoolean(value.processGroupGone);
  assertBoolean(value.forcedKill);
  return { completed: value.completed, processGroupGone: value.processGroupGone, forcedKill: value.forcedKill };
}

function projectStreams(value) {
  assertPlainObject(value, PROBE_ERROR_CODES.OUTPUT_REJECTED);
  assertExactKeys(value, ["stdout", "stderr"]);
  return { stdout: projectStream(value.stdout), stderr: projectStream(value.stderr) };
}

function projectStream(value) {
  assertPlainObject(value, PROBE_ERROR_CODES.OUTPUT_REJECTED);
  assertExactKeys(value, ["observed", "suppressed"]);
  assertBoolean(value.observed);
  assertBoolean(value.suppressed);
  return { observed: value.observed, suppressed: value.suppressed };
}

function projectBudget(value) {
  assertPlainObject(value, PROBE_ERROR_CODES.OUTPUT_REJECTED);
  assertExactKeys(value, ["limits", "used", "remaining"]);
  return {
    limits: projectBudgetPart(value.limits),
    used: projectBudgetPart(value.used),
    remaining: projectBudgetPart(value.remaining)
  };
}

function projectBudgetPart(value) {
  assertPlainObject(value, PROBE_ERROR_CODES.OUTPUT_REJECTED);
  assertExactKeys(value, ["task", "restart", "answer", "continuation"]);
  return Object.fromEntries(Object.entries(value).map(([key, count]) => [key, boundedCount(count)]));
}

function internalIdentity(identity) {
  return {
    requestId: identity.requestId,
    requestKey: identity.requestKey,
    threadId: identity.threadId,
    turnId: identity.turnId,
    itemId: identity.itemId,
    questionIds: [...identity.questionIds]
  };
}

function sameLogicalIdentity(left, right) {
  return left !== null && right !== null
    && left.threadId === right.threadId
    && left.turnId === right.turnId
    && left.itemId === right.itemId
    && Array.isArray(left.questionIds)
    && Array.isArray(right.questionIds)
    && sameKeys(left.questionIds, right.questionIds);
}

function normalizeProtocolId(value, code) {
  if (typeof value === "string") {
    if (!boundedText(value, MAX_ID_LENGTH) || containsSecretLike(value)) {
      throw probeError(code);
    }
    return value;
  }
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) {
    return String(value);
  }
  throw probeError(code);
}

function protocolIdKey(value) {
  if ((typeof value !== "string" && typeof value !== "number")
      || (typeof value === "string" && !boundedText(value, MAX_ID_LENGTH))
      || (typeof value === "number" && (!Number.isSafeInteger(value) || value < 0))) {
    throw probeError(PROBE_ERROR_CODES.INVALID_REQUEST);
  }
  return `${typeof value}:${String(value)}`;
}

function assertGeneration(value) {
  if (!Number.isSafeInteger(value) || value < 1 || value > 2) {
    throw probeError(PROBE_ERROR_CODES.INVALID_REQUEST);
  }
}

function assertPlainObject(value, code) {
  if (!isPlainObject(value)) {
    throw probeError(code);
  }
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}

function assertExactKeys(value, required, optional = [], code = PROBE_ERROR_CODES.INVALID_REQUEST) {
  const allowed = new Set([...required, ...optional]);
  if (Object.keys(value).some((key) => !allowed.has(key)) || required.some((key) => !Object.hasOwn(value, key))) {
    throw probeError(code);
  }
}

function sameKeys(value, expected) {
  return Array.isArray(value)
    ? value.length === expected.length && value.every((item, index) => item === expected[index])
    : Object.keys(value).length === expected.length && expected.every((key) => Object.hasOwn(value, key));
}

function boundedText(value, max) {
  return typeof value === "string" && value.length > 0 && value.length <= max && !containsControlCharacters(value);
}

function containsSecretLike(value) {
  return typeof value === "string" && SECRET_VALUE_PATTERN.test(value);
}

function containsControlCharacters(value) {
  if (typeof value !== "string") {
    return false;
  }
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 0x20 || code === 0x7f) {
      return true;
    }
  }
  return false;
}

function assertProbeEnvironment(value) {
  assertPlainObject(value, PROBE_ERROR_CODES.INVALID_ENVIRONMENT);
  const expected = [
    "CODEX_HOME",
    "TMPDIR",
    "JARVIS_ALLOWED_ROOT",
    "HOME",
    "PATH",
    "LANG",
    "cli_auth_credentials_store"
  ];
  if (!sameKeys(value, expected)) {
    throw probeError(PROBE_ERROR_CODES.INVALID_ENVIRONMENT);
  }
  return buildProbeEnvironment({
    codexHome: value.CODEX_HOME,
    tmpDirectory: value.TMPDIR,
    allowedRoot: value.JARVIS_ALLOWED_ROOT,
    homeDirectory: value.HOME,
    path: value.PATH
  });
}

function boundedCount(value) {
  if (!Number.isSafeInteger(value) || value < 0 || value > MAX_COUNT) {
    throw probeError(PROBE_ERROR_CODES.OUTPUT_REJECTED);
  }
  return value;
}

function boundedDuration(value, max) {
  if (!Number.isSafeInteger(value) || value < 0 || value > max) {
    throw probeError(PROBE_ERROR_CODES.OUTPUT_REJECTED);
  }
  return value;
}

function assertEnum(value, values) {
  if (!values.has(value)) {
    throw probeError(PROBE_ERROR_CODES.OUTPUT_REJECTED);
  }
}

function assertBoolean(value) {
  if (typeof value !== "boolean") {
    throw probeError(PROBE_ERROR_CODES.OUTPUT_REJECTED);
  }
}

function assertSha256(value) {
  if (typeof value !== "string" || !SHA256_PATTERN.test(value)) {
    throw probeError(PROBE_ERROR_CODES.OUTPUT_REJECTED);
  }
}

function assertInternalUuid(value) {
  if (typeof value !== "string" || !INTERNAL_UUID_PATTERN.test(value)) {
    throw probeError(PROBE_ERROR_CODES.OUTPUT_REJECTED);
  }
}

function isWithin(candidate, parent) {
  const remainder = relative(resolve(parent), resolve(candidate));
  return remainder === "" || (remainder !== ".." && !remainder.startsWith("../"));
}

function isOwnerOnly(metadata, mode, uid) {
  return (metadata.mode & 0o777) === mode && (uid < 0 || metadata.uid === uid);
}

async function assertNoSymlinkPath(candidate) {
  const absolute = resolve(candidate);
  const segments = absolute.split("/");
  let current = absolute.startsWith("/") ? "/" : segments.shift();
  for (const segment of segments) {
    if (segment.length === 0) {
      continue;
    }
    current = current === "/" ? `/${segment}` : join(current, segment);
    const metadata = await lstat(current).catch((error) => {
      if (error?.code === "ENOENT") {
        return null;
      }
      throw probeError(PROBE_ERROR_CODES.AUTH_METADATA_INVALID);
    });
    if (metadata?.isSymbolicLink()) {
      throw probeError(PROBE_ERROR_CODES.AUTH_METADATA_INVALID);
    }
  }
}

async function readPrivateJson(path, expectedUid, maxBytes) {
  const contents = await withPrivateFile(path, expectedUid, 0o600, maxBytes, (handle) =>
    handle.readFile({ encoding: "utf8" }));
  try {
    return JSON.parse(contents);
  } catch {
    throw probeError(PROBE_ERROR_CODES.AUTH_METADATA_INVALID);
  }
}

async function assertPrivateFile(path, expectedUid, mode, maxBytes) {
  await withPrivateFile(path, expectedUid, mode, maxBytes, () => undefined);
}

async function withPrivateFile(path, expectedUid, mode, maxBytes, operation) {
  if (typeof fsConstants.O_NOFOLLOW !== "number") {
    throw probeError(PROBE_ERROR_CODES.AUTH_METADATA_INVALID);
  }
  let handle;
  try {
    handle = await open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    const metadata = await handle.stat();
    if (!metadata.isFile()
        || !isOwnerOnly(metadata, mode, expectedUid)
        || !Number.isSafeInteger(metadata.size)
        || metadata.size < 0
        || metadata.size > maxBytes) {
      throw probeError(PROBE_ERROR_CODES.AUTH_METADATA_INVALID);
    }
    return await operation(handle);
  } catch (error) {
    if (error instanceof ProbeError) {
      throw error;
    }
    throw probeError(PROBE_ERROR_CODES.AUTH_METADATA_INVALID);
  } finally {
    await handle?.close().catch(() => {});
  }
}

async function sha256File(path) {
  return await new Promise((resolvePromise, rejectPromise) => {
    const hash = createHash("sha256");
    const stream = createReadStream(path, { highWaterMark: 64 * 1024 });
    stream.on("data", (chunk) => hash.update(chunk));
    stream.once("error", () => rejectPromise(probeError(PROBE_ERROR_CODES.PINNED_BINARY_MISMATCH)));
    stream.once("end", () => resolvePromise(hash.digest("hex")));
  });
}

async function raceTimeout(promise, timeoutMs, code) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, rejectPromise) => {
        timer = setTimeout(() => rejectPromise(probeError(code)), timeoutMs);
      })
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function terminateProcess(child, graceMs, processLifecycle) {
  if (child === null || child === undefined) {
    return { completed: true, processGroupGone: true, forcedKill: false };
  }
  assertProcessLifecycle(processLifecycle);
  let closeObserved = false;
  let forcedKill = false;
  let gone = processLifecycle.isGone();
  if (!gone || !leaderExited(child)) {
    sendProcessSignal(processLifecycle, "SIGTERM");
  }
  closeObserved = await waitForClose(child, graceMs);
  gone = processLifecycle.isGone();
  if (!closeObserved || !gone) {
    forcedKill = true;
    sendProcessSignal(processLifecycle, "SIGKILL");
    if (!closeObserved) {
      closeObserved = await waitForClose(child, graceMs);
    }
    gone = await waitForProcessGroupGone(processLifecycle, graceMs);
  }
  return { completed: closeObserved && gone, processGroupGone: gone, forcedKill };
}

function leaderExited(child) {
  return child?.exitCode !== null && child?.exitCode !== undefined
    || child?.signalCode !== null && child?.signalCode !== undefined;
}

async function waitForClose(child, timeoutMs) {
  if (leaderExited(child)) {
    return true;
  }
  return await new Promise((resolvePromise) => {
    let settled = false;
    const finish = (closed) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      child.off?.("close", finish);
      resolvePromise(closed === true || leaderExited(child));
    };
    const timer = setTimeout(() => finish(false), Math.max(0, timeoutMs));
    child.once?.("close", finish);
    if (leaderExited(child)) {
      finish(true);
    }
  });
}

function processGroupGone(child) {
  const pid = Number.isSafeInteger(child?.pid) ? child.pid : null;
  if (pid === null || process.platform === "win32") {
    return false;
  }
  try {
    process.kill(-pid, 0);
    return false;
  } catch (error) {
    return error?.code === "ESRCH" || error?.code === "ENOENT";
  }
}

function sendProcessSignal(processLifecycle, signal) {
  try {
    processLifecycle.signal(signal);
  } catch {
    // The owned process may have exited between the liveness check and
    // signal delivery; the subsequent bounded liveness check is authoritative.
  }
}

async function waitForProcessGroupGone(processLifecycle, timeoutMs) {
  const end = monotonicNow() + Math.max(0, timeoutMs);
  while (!processLifecycle.isGone()) {
    const remaining = end - monotonicNow();
    if (remaining <= 0) {
      return false;
    }
    await new Promise((resolvePromise) => {
      setTimeout(resolvePromise, Math.min(25, remaining));
    });
  }
  return true;
}

function tomlString(value) {
  return `"${String(value).replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

function probeError(code) {
  return new ProbeError(code);
}

function monotonicNow() {
  return Number(performance.now());
}

export async function runProbeCli({
  argv = process.argv,
  runProbe = runCodexRestartProbe,
  signalSource = process,
  writeLine = (line) => process.stdout.write(line)
} = {}) {
  if (!Array.isArray(argv) || argv.length !== 3 || argv[2] !== "--run") {
    writeLine(JSON.stringify({ schemaVersion: 1, status: "UNVERIFIED", errorCode: "PROBE_RUNTIME_ERROR" }) + "\n");
    return 1;
  }
  const controller = new AbortController();
  const onSignal = () => controller.abort();
  signalSource?.once?.("SIGINT", onSignal);
  signalSource?.once?.("SIGTERM", onSignal);
  try {
    const output = projectProbeOutput(await runProbe({ signal: controller.signal }));
    writeLine(`${JSON.stringify(output)}\n`);
    return output.status === "PASS" ? 0 : 1;
  } catch (error) {
    const code = ERROR_VALUES.has(error?.code) ? error.code : PROBE_ERROR_CODES.PROBE_RUNTIME_ERROR;
    const status = code === PROBE_ERROR_CODES.CANCELLED ? "CANCELLED" : "FAIL";
    writeLine(JSON.stringify({ schemaVersion: 1, status, errorCode: code }) + "\n");
    return 1;
  } finally {
    signalSource?.removeListener?.("SIGINT", onSignal);
    signalSource?.removeListener?.("SIGTERM", onSignal);
  }
}

async function main() {
  process.exitCode = await runProbeCli();
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  void main();
}
