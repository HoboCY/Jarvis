import {
  createDesktopActionFailureError,
  desktopActionFailureMessage,
  isDesktopActionFailureProjection,
  projectDesktopActionFailure,
  type DesktopActionFailureCode,
  type DesktopActionFailureKind
} from "./desktop-ipc.js";

export type { DesktopActionFailureCode, DesktopActionFailureKind } from "./desktop-ipc.js";

export type DesktopActionStatus = "pending" | "succeeded" | "retryable" | "terminal";

export type DesktopActionFailure = {
  kind: DesktopActionFailureKind;
  code: DesktopActionFailureCode;
  message: string;
};

export type DesktopActionState = {
  key: string;
  status: DesktopActionStatus;
  idempotencyKey: string;
  retryable: boolean;
  code?: DesktopActionFailureCode;
  message?: string;
};

export type DesktopActionRunnerOptions = {
  createIdempotencyKey?: (key: string) => string;
  onStateChange?: (state: DesktopActionState) => void;
  onStateReset?: (key: string) => void;
};

type ActionEntry = DesktopActionState & {
  inFlight?: Promise<unknown>;
  result?: unknown;
  error?: unknown;
};

const maximumActionKeyLength = 200;
const maximumActionMessageLength = 240;

function failureFromProjection(reason: unknown): DesktopActionFailure | undefined {
  if (!isDesktopActionFailureProjection(reason)) {
    return undefined;
  }
  return {
    kind: reason.kind,
    code: reason.code,
    message: desktopActionFailureMessage(reason.code)
  };
}

export function createDesktopActionFailure(
  kind: DesktopActionFailureKind,
  code: DesktopActionFailureCode
): Error {
  return createDesktopActionFailureError(kind, code);
}

export function desktopActionFailureFrom(reason: unknown): DesktopActionFailure {
  return failureFromProjection(projectDesktopActionFailure(reason))!;
}

export function classifyDesktopActionFailure(reason: unknown): DesktopActionFailureKind {
  return desktopActionFailureFrom(reason).kind;
}

export function desktopActionMessage(reason: unknown): string {
  return desktopActionFailureFrom(reason).message.slice(0, maximumActionMessageLength);
}

export type DesktopNotificationFeedbackAction = "delivered" | "acknowledge" | "read" | "dismiss";

export type DesktopNotificationActionStates = Readonly<{
  delivered?: DesktopActionState;
  acknowledge?: DesktopActionState;
  read?: DesktopActionState;
  dismiss?: DesktopActionState;
}>;

export type DesktopNotificationFeedbackEntry = Readonly<{
  action: DesktopNotificationFeedbackAction;
  state: DesktopActionState;
}>;

export type DesktopNotificationFeedbackProjection = Readonly<{
  delivered?: DesktopNotificationFeedbackEntry;
  actions: readonly DesktopNotificationFeedbackEntry[];
}>;

export function projectDesktopNotificationFeedback(
  states: DesktopNotificationActionStates
): DesktopNotificationFeedbackProjection {
  const actions: DesktopNotificationFeedbackEntry[] = [];
  for (const action of ["acknowledge", "read", "dismiss"] as const) {
    const state = states[action];
    if (state) {
      actions.push({ action, state });
    }
  }

  return {
    ...(states.delivered ? { delivered: { action: "delivered", state: states.delivered } } : {}),
    actions
  };
}

export type TaskInputAnswers = Record<string, { answers: string[] }>;

export type TaskInputSubmission = {
  actionKey: string;
  isNewAttempt: boolean;
  payload: TaskInputAnswers;
  canonicalPayload: string;
};

export type DesktopActionAttemptIdentity = Readonly<{
  actionKey: string;
  attemptId: string;
}>;

export type DesktopActionAttemptLedgerOptions = {
  createAttemptId?: () => string;
};

const maximumAttemptIdLength = 64;
let fallbackAttemptSequence = 0;

function createDesktopAttemptId(): string {
  if (typeof globalThis.crypto?.randomUUID === "function") {
    return globalThis.crypto.randomUUID();
  }
  fallbackAttemptSequence++;
  return `attempt-${Date.now().toString(36)}-${fallbackAttemptSequence.toString(36)}`;
}

function normalizeAttemptId(value: string): string {
  const normalized = value.trim();
  if (!normalized
    || normalized.length > maximumAttemptIdLength
    || !/^[A-Za-z0-9_-]+$/.test(normalized)) {
    throw new Error("A bounded Desktop action attempt identity is required.");
  }
  return normalized;
}

export class DesktopLogicalActionAttemptLedger {
  public readonly baseKey: string;
  private readonly createAttemptId: () => string;
  private currentAttempt: DesktopActionAttemptIdentity | undefined;

  public constructor(
    baseKey: string,
    options: DesktopActionAttemptLedgerOptions = {}
  ) {
    const normalized = baseKey.trim();
    if (!normalized || normalized.length > maximumActionKeyLength - maximumAttemptIdLength - 1) {
      throw new Error("A bounded Desktop action key base is required.");
    }
    this.baseKey = normalized;
    this.createAttemptId = options.createAttemptId ?? createDesktopAttemptId;
  }

  public get current(): DesktopActionAttemptIdentity | undefined {
    return this.currentAttempt;
  }

  public begin(): DesktopActionAttemptIdentity {
    const attemptId = normalizeAttemptId(this.createAttemptId());
    const actionKey = `${this.baseKey}:${attemptId}`;
    if (actionKey.length > maximumActionKeyLength) {
      throw new Error("A bounded Desktop action attempt identity is required.");
    }
    this.currentAttempt = Object.freeze({ actionKey, attemptId });
    return this.currentAttempt;
  }
}

function cloneTaskInputAnswers(payload: TaskInputAnswers): TaskInputAnswers {
  const cloned: TaskInputAnswers = {};
  for (const key of Object.keys(payload).sort()) {
    const value = payload[key];
    cloned[key] = { answers: [...(value?.answers ?? [])].map(answer => answer.trim()) };
  }
  return cloned;
}

function freezeTaskInputAnswers(payload: TaskInputAnswers): TaskInputAnswers {
  for (const value of Object.values(payload)) {
    Object.freeze(value.answers);
    Object.freeze(value);
  }
  return Object.freeze(payload);
}

export function canonicalTaskInputPayload(payload: TaskInputAnswers): string {
  return JSON.stringify(Object.keys(payload).sort().reduce<TaskInputAnswers>((result, key) => {
    result[key] = { answers: [...(payload[key]?.answers ?? [])].map(answer => answer.trim()) };
    return result;
  }, {}));
}

type TaskInputAttempt = Readonly<{
  canonicalPayload: string;
  actionKey: string;
  payload: TaskInputAnswers;
}>;

export type TaskInputAttemptLedgerOptions = DesktopActionAttemptLedgerOptions;

export class TaskInputAttemptLedger {
  public readonly baseKey: string;
  private readonly attempts = new Map<string, TaskInputAttempt>();
  private readonly createAttemptId: () => string;
  private readonly previewActionKey = "task-input:preview";
  private committedAttempt: TaskInputAttempt | undefined;

  public constructor(baseKey: string, options: TaskInputAttemptLedgerOptions = {}) {
    const normalized = baseKey.trim();
    if (!normalized || normalized.length > maximumActionKeyLength * 2) {
      throw new Error("A bounded Task input action key is required.");
    }
    this.baseKey = normalized;
    this.createAttemptId = options.createAttemptId ?? createDesktopAttemptId;
  }

  public prepare(payload: TaskInputAnswers): TaskInputSubmission {
    const canonicalPayload = canonicalTaskInputPayload(payload);
    const attempt = this.ensureAttempt(canonicalPayload, payload);
    const isNewAttempt = this.committedAttempt !== undefined
      && this.committedAttempt.canonicalPayload !== canonicalPayload;
    return {
      actionKey: attempt.actionKey,
      isNewAttempt,
      payload: freezeTaskInputAnswers(cloneTaskInputAnswers(attempt.payload)),
      canonicalPayload
    };
  }

  public commit(submission: Pick<TaskInputSubmission, "actionKey" | "canonicalPayload">): void {
    const attempt = this.attempts.get(submission.canonicalPayload);
    if (!attempt || attempt.actionKey !== submission.actionKey) {
      throw new Error("The Task input attempt is no longer available.");
    }
    this.committedAttempt = attempt;
  }

  public actionFor(payload: TaskInputAnswers): Pick<TaskInputSubmission, "actionKey" | "canonicalPayload"> {
    const canonicalPayload = canonicalTaskInputPayload(payload);
    const attempt = this.attempts.get(canonicalPayload);
    return { actionKey: attempt?.actionKey ?? this.previewActionKey, canonicalPayload };
  }

  private ensureAttempt(canonicalPayload: string, payload: TaskInputAnswers): TaskInputAttempt {
    const existing = this.attempts.get(canonicalPayload);
    if (existing) {
      return existing;
    }

    const attemptId = normalizeAttemptId(this.createAttemptId());
    const actionKey = `task-input:${attemptId}`;
    if (actionKey.length > maximumActionKeyLength
      || [...this.attempts.values()].some(attempt => attempt.actionKey === actionKey)) {
      throw new Error("A unique bounded Task input action identity is required.");
    }
    const attempt = Object.freeze({
      canonicalPayload,
      actionKey,
      payload: freezeTaskInputAnswers(cloneTaskInputAnswers(payload))
    });
    this.attempts.set(canonicalPayload, attempt);
    return attempt;
  }
}

export type TaskInputRunAction = <T>(
  key: string,
  execute: (idempotencyKey: string) => Promise<T>
) => Promise<T>;

export type TaskInputSubmissionFlowOptions = Readonly<{
  ledger: TaskInputAttemptLedger;
  payload: TaskInputAnswers;
  reconcile: (submission: TaskInputSubmission) => Promise<boolean>;
  runAction: TaskInputRunAction;
  submit: (submission: TaskInputSubmission, idempotencyKey: string) => Promise<unknown>;
}>;

export async function submitTaskInputWithReconcile(
  options: TaskInputSubmissionFlowOptions
): Promise<TaskInputSubmission | undefined> {
  const submission = options.ledger.prepare(options.payload);
  if (submission.isNewAttempt && !await options.reconcile(submission)) {
    return undefined;
  }

  options.ledger.commit(submission);
  await options.runAction(submission.actionKey, idempotencyKey =>
    options.submit(submission, idempotencyKey));
  return submission;
}

export class ApprovalActionCoordinator {
  private readonly pending = new Set<string>();

  public begin(approvalId: string): boolean {
    const key = approvalId.trim();
    if (!key || this.pending.has(key)) {
      return false;
    }
    this.pending.add(key);
    return true;
  }

  public end(approvalId: string): void {
    this.pending.delete(approvalId.trim());
  }

  public isBusy(approvalId: string): boolean {
    return this.pending.has(approvalId.trim());
  }
}

export const realtimeActionKeys = [
  "realtime-connect",
  "realtime-disconnect",
  "realtime-retry-persistence",
  "realtime-retry-wake"
] as const;

export class DesktopRealtimeActionCycle {
  private cycle = 0;

  public constructor(private readonly runner: DesktopActionRunner) {}

  public begin(): number {
    this.cycle++;
    for (const key of realtimeActionKeys) {
      this.runner.reset(key);
    }
    return this.cycle;
  }

  public get current(): number {
    return this.cycle;
  }
}

export type DesktopRealtimeRetryProjectionInput = Readonly<{
  status: "disconnected" | "connecting" | "connected" | "degraded";
  wakeState: "standby" | "awake" | "error";
  hasController: boolean;
  persistenceRetryReason?: "event-ingest" | "session-end";
  persistenceAction?: DesktopActionState;
  wakeAction?: DesktopActionState;
}>;

export type DesktopRealtimeRetryProjection = Readonly<{
  persistence: boolean;
  wake: boolean;
}>;

function matchesUnresolvedRealtimeAction(
  state: DesktopActionState | undefined,
  expectedKey: "realtime-retry-persistence" | "realtime-retry-wake"
): boolean {
  return state === undefined || (state.key === expectedKey && state.status !== "succeeded");
}

export function projectRealtimeRetryControls(
  input: DesktopRealtimeRetryProjectionInput
): DesktopRealtimeRetryProjection {
  return {
    persistence: input.persistenceRetryReason !== undefined
      && matchesUnresolvedRealtimeAction(input.persistenceAction, "realtime-retry-persistence"),
    wake: input.hasController
      && input.status === "connected"
      && input.wakeState === "error"
      && matchesUnresolvedRealtimeAction(input.wakeAction, "realtime-retry-wake")
  };
}

export function scrollBehaviorForReducedMotion(reducedMotion: boolean): "auto" | "smooth" {
  return reducedMotion ? "auto" : "smooth";
}

export function defaultDesktopActionIdempotencyKey(key: string): string {
  const normalized = key.trim();
  if (!normalized || normalized.length > maximumActionKeyLength) {
    throw new Error("A bounded Desktop action key is required.");
  }

  const directKey = `desktop-action:${normalized}`;
  if (directKey.length <= maximumActionKeyLength) {
    return directKey;
  }

  let hash = 2_166_136_261;
  for (const character of normalized) {
    hash = Math.imul(hash ^ character.codePointAt(0)!, 16_777_619);
  }
  return `desktop-action:${normalized.slice(0, 160)}:${(hash >>> 0).toString(16)}`;
}

export class DesktopActionRunner {
  private readonly entries = new Map<string, ActionEntry>();
  private readonly createIdempotencyKey: (key: string) => string;
  private readonly onStateChange?: (state: DesktopActionState) => void;
  private readonly onStateReset?: (key: string) => void;

  public constructor(options: DesktopActionRunnerOptions = {}) {
    this.createIdempotencyKey = options.createIdempotencyKey ?? defaultDesktopActionIdempotencyKey;
    this.onStateChange = options.onStateChange;
    this.onStateReset = options.onStateReset;
  }

  public get(key: string): DesktopActionState | undefined {
    const entry = this.entries.get(key);
    if (!entry) {
      return undefined;
    }

    return this.snapshot(entry);
  }

  public reset(key: string): void {
    const normalizedKey = key.trim();
    const entry = this.entries.get(normalizedKey);
    if (entry?.inFlight) {
      return;
    }
    if (this.entries.delete(normalizedKey)) {
      this.onStateReset?.(normalizedKey);
    }
  }

  public run<T>(key: string, execute: (idempotencyKey: string) => Promise<T>): Promise<T> {
    const normalizedKey = key.trim();
    if (!normalizedKey || normalizedKey.length > maximumActionKeyLength) {
      return Promise.reject(new Error("A bounded Desktop action key is required."));
    }

    const existing = this.entries.get(normalizedKey);
    if (existing?.inFlight) {
      return existing.inFlight as Promise<T>;
    }
    if (existing?.status === "succeeded") {
      return Promise.resolve(existing.result as T);
    }
    if (existing?.status === "terminal") {
      return Promise.reject(existing.error ?? new Error(existing.message ?? "操作不可用。"));
    }

    const idempotencyKey = existing?.idempotencyKey ?? this.createIdempotencyKey(normalizedKey);
    if (!idempotencyKey || idempotencyKey.length > maximumActionKeyLength) {
      return Promise.reject(new Error("A bounded Desktop action idempotency key is required."));
    }

    const entry: ActionEntry = existing ?? {
      key: normalizedKey,
      status: "pending",
      idempotencyKey,
      retryable: false
    };
    entry.status = "pending";
    entry.retryable = false;
    entry.code = undefined;
    entry.message = undefined;
    entry.error = undefined;
    this.entries.set(normalizedKey, entry);
    this.publish(entry);

    const operation = Promise.resolve()
      .then(() => execute(idempotencyKey))
      .then(result => {
        entry.inFlight = undefined;
        entry.result = result;
        entry.status = "succeeded";
        entry.retryable = false;
        entry.message = undefined;
        this.publish(entry);
        return result;
      })
      .catch(reason => {
        entry.inFlight = undefined;
        entry.error = reason;
        const failure = desktopActionFailureFrom(reason);
        entry.status = failure.kind;
        entry.retryable = entry.status === "retryable";
        entry.code = failure.code;
        entry.message = failure.message;
        this.publish(entry);
        throw entry.error;
      });
    entry.inFlight = operation;
    return operation;
  }

  private snapshot(entry: ActionEntry): DesktopActionState {
    return {
      key: entry.key,
      status: entry.status,
      idempotencyKey: entry.idempotencyKey,
      retryable: entry.retryable,
      ...(entry.code ? { code: entry.code } : {}),
      ...(entry.message ? { message: entry.message } : {})
    };
  }

  private publish(entry: ActionEntry): void {
    this.onStateChange?.(this.snapshot(entry));
  }
}

export function clearOppositeApprovalRetryable(
  runner: Pick<DesktopActionRunner, "get" | "reset">,
  approvalId: string,
  decision: "approve" | "deny"
): void {
  const oppositeDecision = decision === "approve" ? "deny" : "approve";
  const oppositeKey = `approval-${oppositeDecision}:${approvalId}`;
  if (runner.get(oppositeKey)?.status === "retryable") {
    runner.reset(oppositeKey);
  }
}
