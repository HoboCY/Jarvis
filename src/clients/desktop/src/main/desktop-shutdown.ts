import { randomUUID } from "node:crypto";

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type DesktopShutdownAckStatus = "completed" | "failed";

export type DesktopShutdownSession = {
  sessionId: string;
  externalSessionId: string;
  bearer?: string;
};

export type DesktopPendingConnectionIntent = DesktopShutdownSession & {
  idempotencyKey: string;
};

export type DesktopShutdownTerminalStatus = "rotated" | "disconnected" | "failed";

export type DesktopShutdownTerminalIntent = {
  reason: string;
  status: DesktopShutdownTerminalStatus;
};

export type DesktopShutdownTerminalOperation = {
  idempotencyKey: string;
  intent: DesktopShutdownTerminalIntent;
};

export type DesktopShutdownFallbackSession = DesktopShutdownSession & {
  reason: string;
  status: DesktopShutdownTerminalStatus;
  idempotencyKey?: string;
  takeoverPendingTerminal?: boolean;
  terminalIntent?: DesktopShutdownTerminalIntent;
};

export type DesktopShutdownRendererTarget = {
  sender: object;
  frame: object;
  isDestroyed: () => boolean;
  send: (channel: "app:prepareShutdown", value: { requestId: string }) => void;
};

export type DesktopShutdownAck = {
  sender: object;
  frame: object;
  requestId: string;
  status: DesktopShutdownAckStatus;
};

export type DesktopShutdownResult =
  | { status: "idle" }
  | { status: "acknowledged" }
  | { status: "fallback" }
  | { status: "fallback-failed"; errorCode: "BACKEND_UNAVAILABLE" | "SHUTDOWN_TIMEOUT" }
  | { status: "no-bearer" };

export type DesktopShutdownDependencies = {
  getRendererTarget: () => DesktopShutdownRendererTarget | undefined;
  getActiveSession: () => DesktopShutdownSession | undefined;
  fallbackMainSession: (session: DesktopShutdownFallbackSession) => Promise<void>;
  clearSession?: (sessionId: string) => void;
  freeze: () => void;
  stopWake: () => Promise<void> | void;
  stopSignalR: () => Promise<void> | void;
  closeWindows: () => void;
  continueQuit: () => void;
  waitForPendingOperations?: () => Promise<boolean>;
  getPendingConnectionIntents?: () => readonly DesktopPendingConnectionIntent[];
  recoverPendingConnection?: (intent: DesktopPendingConnectionIntent) => Promise<void>;
  getRegisteredSessions?: () => readonly DesktopShutdownSession[];
  getPendingTerminalSessions?: () => readonly DesktopShutdownSession[];
  getPendingTerminalIdempotencyKey?: (sessionId: string) => string | undefined;
  getPendingTerminalIntent?: (sessionId: string) => DesktopShutdownTerminalIntent | undefined;
  createRequestId?: () => string;
  timeoutMs?: number;
};

export class DesktopRealtimeSessionRegistry {
  private session: DesktopShutdownSession | undefined;
  private accepting = true;
  private readonly pendingOperations = new Set<Promise<unknown>>();
  private readonly pendingTerminals = new Map<string, PendingTerminal>();
  private readonly sessions = new Map<string, DesktopShutdownSession>();
  private readonly pendingConnections = new Map<string, PendingConnection>();
  private readonly terminalIdempotencyKeys = new Map<string, string>();
  private readonly terminalIntents = new Map<string, DesktopShutdownTerminalIntent>();
  private readonly completedTerminals = new Set<string>();

  public get activeSession(): DesktopShutdownSession | undefined {
    return this.session === undefined ? undefined : { ...this.session };
  }

  public freeze(): void {
    this.accepting = false;
  }

  public markConnected(session: DesktopShutdownSession): boolean {
    if (!this.accepting || !isUuid(session.sessionId)
      || this.completedTerminals.has(session.sessionId)
      || typeof session.externalSessionId !== "string"
      || session.externalSessionId.trim().length === 0
      || session.externalSessionId.length > 200
      || session.bearer !== undefined && (typeof session.bearer !== "string" || session.bearer.length < 32)) {
      return false;
    }
    this.session = { ...session, externalSessionId: session.externalSessionId.trim() };
    this.sessions.set(session.sessionId, this.session);
    const pendingConnection = this.pendingConnections.get(session.sessionId);
    if (pendingConnection?.state === "pending") {
      this.pendingConnections.delete(session.sessionId);
    }
    return true;
  }

  public acceptPendingConnectionDuringShutdown(intent: DesktopPendingConnectionIntent): boolean {
    const pending = this.pendingConnections.get(intent.sessionId);
    if (!pending || pending.state !== "recovering" || !sameConnectionIntent(pending.intent, intent)
      || this.completedTerminals.has(intent.sessionId)) {
      return false;
    }
    const session: DesktopShutdownSession = {
      sessionId: intent.sessionId,
      externalSessionId: intent.externalSessionId,
      ...(intent.bearer === undefined ? {} : { bearer: intent.bearer })
    };
    if (!isValidSession(session)) {
      return false;
    }
    this.session = { ...session };
    this.sessions.set(session.sessionId, this.session);
    pending.state = "recovered";
    return true;
  }

  public markEnded(sessionId: string): boolean {
    if (!isUuid(sessionId)) {
      return false;
    }
    const wasCurrent = this.session?.sessionId === sessionId;
    this.markTerminalCompleted(sessionId);
    return wasCurrent;
  }

  public clearIfCurrent(sessionId: string): boolean {
    return this.markEnded(sessionId);
  }

  public trackPendingConnection<T>(
    operation: Promise<T>,
    intent?: DesktopPendingConnectionIntent
  ): Promise<T> {
    const trackedOperation = this.trackPendingOperation(operation);
    if (intent !== undefined) {
      const pending: PendingConnection = {
        intent: { ...intent },
        state: "pending",
        tracked: trackedOperation
      };
      this.pendingConnections.set(intent.sessionId, pending);
      void operation.then(
        () => {
          if (this.pendingConnections.get(intent.sessionId) === pending
            && pending.state === "pending") {
            this.pendingConnections.delete(intent.sessionId);
          }
        },
        () => {
          if (this.pendingConnections.get(intent.sessionId) === pending
            && pending.state === "pending") {
            this.pendingConnections.delete(intent.sessionId);
          }
        });
    }
    return operation;
  }

  public trackPendingOperation<T>(operation: Promise<T>): Promise<T> {
    const tracked = operation.finally(() => this.pendingOperations.delete(tracked));
    this.pendingOperations.add(tracked);
    void tracked.catch(() => undefined);
    return operation;
  }

  public runPendingTerminal<T>(
    sessionId: string,
    operation: () => Promise<T>,
    terminalOperation: DesktopShutdownTerminalOperation
  ): Promise<T> {
    if (!isUuid(sessionId)) {
      return Promise.reject(new Error("Realtime session id is invalid."));
    }
    if (this.completedTerminals.has(sessionId)) {
      return Promise.resolve(undefined as T);
    }

    const inFlight = this.pendingTerminals.get(sessionId);
    if (inFlight) {
      return inFlight.promise as Promise<T>;
    }
    return this.startPendingTerminal(sessionId, operation, terminalOperation);
  }

  public takeoverPendingTerminal<T>(
    sessionId: string,
    operation: () => Promise<T>,
    terminalOperation: DesktopShutdownTerminalOperation
  ): Promise<T> {
    if (!isUuid(sessionId)) {
      return Promise.reject(new Error("Realtime session id is invalid."));
    }
    if (this.completedTerminals.has(sessionId)) {
      return Promise.resolve(undefined as T);
    }
    const inFlight = this.pendingTerminals.get(sessionId);
    if (inFlight) {
      // The original request may be an unabortable fetch. It is no longer
      // allowed to consume the shutdown budget after the coordinator has
      // explicitly reserved the fallback slice.
      this.pendingOperations.delete(inFlight.tracked);
      this.pendingTerminals.delete(sessionId);
    }
    return this.startPendingTerminal(sessionId, operation, terminalOperation);
  }

  public getPendingConnectionIntents(): readonly DesktopPendingConnectionIntent[] {
    return [...this.pendingConnections.values()]
      .filter(pending => pending.state === "pending" || pending.state === "recovering")
      .map(pending => ({ ...pending.intent }));
  }

  public getPendingConnectionRecovery(sessionId: string): Promise<void> | undefined {
    const pending = this.pendingConnections.get(sessionId);
    return pending?.recovery;
  }

  public isTerminalCompleted(sessionId: string): boolean {
    return this.completedTerminals.has(sessionId);
  }

  public takeoverPendingConnection(
    intent: DesktopPendingConnectionIntent,
    operation: () => Promise<void>
  ): Promise<void> {
    const pending = this.pendingConnections.get(intent.sessionId);
    if (!pending || !sameConnectionIntent(pending.intent, intent)
      || this.completedTerminals.has(intent.sessionId)) {
      return Promise.reject(new Error("Realtime connection is not pending."));
    }
    if (pending.recovery !== undefined) {
      return pending.recovery;
    }
    this.pendingOperations.delete(pending.tracked);
    pending.state = "recovering";
    const recovery = Promise.resolve().then(operation);
    pending.recovery = recovery;
    const tracked = recovery.finally(() => this.pendingOperations.delete(tracked));
    this.pendingOperations.add(tracked);
    void tracked.catch(() => undefined);
    return recovery;
  }

  public getPendingTerminalSessions(): readonly DesktopShutdownSession[] {
    const sessions: DesktopShutdownSession[] = [];
    for (const sessionId of this.pendingTerminals.keys()) {
      const session = this.sessions.get(sessionId);
      if (session !== undefined) {
        sessions.push({ ...session });
      }
    }
    return sessions;
  }

  public getRegisteredSessions(): readonly DesktopShutdownSession[] {
    return [...this.sessions.values()].map(session => ({ ...session }));
  }

  public getPendingTerminalIdempotencyKey(sessionId: string): string | undefined {
    return this.terminalIdempotencyKeys.get(sessionId);
  }

  public getPendingTerminalIntent(sessionId: string): DesktopShutdownTerminalIntent | undefined {
    const intent = this.terminalIntents.get(sessionId);
    return intent === undefined ? undefined : { ...intent };
  }

  public markTerminalCompleted(sessionId: string): boolean {
    if (!isUuid(sessionId)) {
      return false;
    }
    this.completedTerminals.add(sessionId);
    if (this.session?.sessionId === sessionId) {
      this.session = undefined;
    }
    this.sessions.delete(sessionId);
    this.pendingConnections.delete(sessionId);
    this.pendingTerminals.delete(sessionId);
    return true;
  }

  private startPendingTerminal<T>(
    sessionId: string,
    operation: () => Promise<T>,
    terminalOperation: DesktopShutdownTerminalOperation
  ): Promise<T> {
    this.terminalIdempotencyKeys.set(sessionId, terminalOperation.idempotencyKey);
    this.terminalIntents.set(sessionId, { ...terminalOperation.intent });
    const result = Promise.resolve().then(operation);
    const tracked = result.finally(() => this.pendingOperations.delete(tracked));
    this.pendingOperations.add(tracked);
    void tracked.catch(() => undefined);
    const pending: PendingTerminal = {
      promise: result,
      tracked
    };
    this.pendingTerminals.set(sessionId, pending);
    void result.then(
      () => {
        if (this.pendingTerminals.get(sessionId) === pending) {
          this.pendingTerminals.delete(sessionId);
        }
      },
      () => {
        if (this.pendingTerminals.get(sessionId) === pending) {
          this.pendingTerminals.delete(sessionId);
        }
      });
    return result;
  }

  public async waitForPendingConnections(): Promise<boolean> {
    return await this.waitForPendingOperations();
  }

  public async waitForPendingOperations(): Promise<boolean> {
    let completed = true;
    while (this.pendingOperations.size > 0) {
      const results = await Promise.allSettled([...this.pendingOperations]);
      completed &&= results.every(result => result.status === "fulfilled"
        && result.value !== false);
    }
    return completed;
  }
}

type PendingTerminal = {
  promise: Promise<unknown>;
  tracked: Promise<unknown>;
};

type PendingConnection = {
  intent: DesktopPendingConnectionIntent;
  state: "pending" | "recovering" | "recovered";
  tracked: Promise<unknown>;
  recovery?: Promise<void>;
};

export class DesktopShutdownCoordinator {
  private readonly timeoutMs: number;
  private completion: Promise<DesktopShutdownResult> | undefined;
  private activeRequestId: string | undefined;
  private activeTarget: DesktopShutdownRendererTarget | undefined;
  private resolveAck: ((ack: DesktopShutdownAckStatus) => void) | undefined;
  private acknowledgementReceived = false;
  private continuationAllowed = false;
  private shutdownInProgress = false;
  private cleanupStarted = false;

  public constructor(private readonly dependencies: DesktopShutdownDependencies) {
    const timeoutMs = dependencies.timeoutMs ?? 5_000;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 5_000) {
      throw new RangeError("Desktop shutdown timeout is invalid.");
    }
    this.timeoutMs = timeoutMs;
  }

  public get isQuitting(): boolean {
    return this.completion !== undefined;
  }

  public get canContinueQuit(): boolean {
    return this.continuationAllowed;
  }

  public requestQuit(event: { preventDefault: () => void }): void {
    if (this.continuationAllowed) {
      return;
    }
    event.preventDefault();
    if (this.completion !== undefined || this.shutdownInProgress) {
      return;
    }

    this.shutdownInProgress = true;
    try {
      this.dependencies.freeze();
    } catch {
      // The coordinator still closes the owned resources if a freeze hook is unavailable.
    }
    try {
      this.activeRequestId = this.createRequestId();
    } catch {
      // A malformed injected id must not leave Electron waiting forever. A
      // fresh process UUID keeps the request correlation exact while the
      // renderer remains unable to provide a caller-controlled id.
      this.activeRequestId = randomUUID();
    }
    try {
      this.activeTarget = this.dependencies.getRendererTarget();
    } catch {
      this.activeTarget = undefined;
    }
    this.completion = this.coordinate(this.activeRequestId, this.activeTarget)
      .catch((): DesktopShutdownResult => ({ status: "fallback-failed", errorCode: "BACKEND_UNAVAILABLE" }))
      .then(result => {
        this.continuationAllowed = true;
        try {
          this.dependencies.continueQuit();
        } catch {
          // Electron's quit continuation is best effort; cleanup already completed.
        }
        return result;
      });
  }

  public handleShutdownAck(value: unknown): boolean {
    if (!this.shutdownInProgress || this.resolveAck === undefined
      || this.acknowledgementReceived || this.activeTarget === undefined
      || !isRecord(value)) {
      return false;
    }
    if (value.sender !== this.activeTarget.sender || value.frame !== this.activeTarget.frame
      || value.requestId !== this.activeRequestId
      || (value.status !== "completed" && value.status !== "failed")) {
      return false;
    }
    if (Object.keys(value).some(key => !["sender", "frame", "requestId", "status"].includes(key))) {
      return false;
    }
    this.acknowledgementReceived = true;
    this.resolveAck(value.status);
    return true;
  }

  public async waitForCompletion(): Promise<DesktopShutdownResult> {
    return await (this.completion ?? Promise.resolve({ status: "idle" }));
  }

  private createRequestId(): string {
    const value = this.dependencies.createRequestId?.() ?? randomUUID();
    if (!isUuid(value)) {
      throw new Error("Shutdown request id is invalid.");
    }
    return value;
  }

  private async coordinate(
    requestId: string,
    target: DesktopShutdownRendererTarget | undefined
  ): Promise<DesktopShutdownResult> {
    const deadlineAt = monotonicNow() + this.timeoutMs;
    let result: DesktopShutdownResult;
    let rendererStatus: DesktopShutdownAckStatus | "timeout" | undefined;
    let rendererUnavailable = target === undefined;
    const fallbackReserveMs = Math.min(
      Math.max(0, this.timeoutMs - 1),
      Math.max(5, Math.floor(this.timeoutMs / 4)));
    try {
      rendererUnavailable ||= target?.isDestroyed() ?? false;
    } catch {
      rendererUnavailable = true;
    }
    if (rendererUnavailable || target === undefined) {
      rendererStatus = "failed";
    } else {
      const acknowledgement = new Promise<DesktopShutdownAckStatus>(resolve => {
        this.resolveAck = resolve;
      });
      try {
        target.send("app:prepareShutdown", { requestId });
        // Reserve a small bounded slice for the Main fallback and cleanup so
        // an ACK timeout cannot consume the entire quit budget.
        const acknowledgementDeadlineAt = deadlineAt - fallbackReserveMs;
        const acknowledgementResult = await this.withDeadline(acknowledgement, acknowledgementDeadlineAt);
        rendererStatus = acknowledgementResult.completed
          ? acknowledgementResult.value
          : "timeout";
      } catch {
        rendererStatus = "failed";
      }
    }

    let pendingOperations: Promise<boolean>;
    try {
      pendingOperations = this.dependencies.waitForPendingOperations?.() ?? Promise.resolve(true);
    } catch {
      pendingOperations = Promise.resolve(false);
    }
    const pendingResult = await this.withDeadline(
      pendingOperations.catch(() => false),
      deadlineAt - fallbackReserveMs);
    let recoveredPendingConnection = false;
    if (!pendingResult.completed) {
      const sessions = this.fallbackSessions();
      // A pending Connected request can remain unabortable. Start recovery and
      // close every already-confirmed session together so a hanging replacement
      // cannot consume the only budget available to an older live session.
      const pendingRecovery = this.recoverPendingConnections(deadlineAt);
      const existingSessionFallback = sessions.length > 0
        ? this.useFallbacks(sessions, deadlineAt, true)
        : Promise.resolve<DesktopShutdownResult>({ status: "no-bearer" });
      [recoveredPendingConnection, result] = await Promise.all([
        pendingRecovery,
        existingSessionFallback
      ]);
      if (result.status === "no-bearer") {
        result = recoveredPendingConnection
          ? { status: "fallback" }
          : { status: "fallback-failed", errorCode: "SHUTDOWN_TIMEOUT" };
      }
    } else if (!pendingResult.value) {
      const sessions = this.fallbackSessions();
      result = sessions.length > 0
        ? await this.useFallbacks(sessions, deadlineAt, false)
        : { status: "fallback-failed", errorCode: "BACKEND_UNAVAILABLE" };
    } else if (rendererStatus === "completed") {
      // A renderer ACK can race the final continuation of connect(). If Main
      // still owns a successfully registered session, close it through the
      // one trusted fallback path before allowing Electron to quit.
      const sessions = this.fallbackSessions();
      result = sessions.length === 0
        ? { status: "acknowledged" }
        : await this.useFallbacks(sessions, deadlineAt, false);
    } else {
      const sessions = this.fallbackSessions();
      result = sessions.length === 0
        ? { status: "no-bearer" }
        : await this.useFallbacks(sessions, deadlineAt, false);
    }

    const cleanupCompleted = await this.cleanup(deadlineAt);
    if (!cleanupCompleted && result.status !== "fallback-failed") {
      result = { status: "fallback-failed", errorCode: "SHUTDOWN_TIMEOUT" };
    }
    return result;
  }

  private fallbackSessions(): DesktopShutdownSession[] {
    const sessions = new Map<string, DesktopShutdownSession>();
    const activeSession = this.dependencies.getActiveSession();
    if (activeSession !== undefined) {
      sessions.set(activeSession.sessionId, { ...activeSession });
    }
    for (const session of this.dependencies.getRegisteredSessions?.() ?? []) {
      sessions.set(session.sessionId, { ...session });
    }
    for (const session of this.dependencies.getPendingTerminalSessions?.() ?? []) {
      sessions.set(session.sessionId, { ...session });
    }
    return [...sessions.values()];
  }

  private async recoverPendingConnections(deadlineAt: number): Promise<boolean> {
    const intents = this.dependencies.getPendingConnectionIntents?.() ?? [];
    if (intents.length === 0) {
      return false;
    }
    const recover = this.dependencies.recoverPendingConnection;
    if (recover === undefined) {
      return false;
    }
    const results = await Promise.all(intents.map(async intent => {
      try {
        return (await this.withDeadline(recover(intent), deadlineAt)).completed;
      } catch {
        return false;
      }
    }));
    return results.every(Boolean);
  }

  private async useFallbacks(
    sessions: readonly DesktopShutdownSession[],
    deadlineAt: number,
    takeoverPendingTerminal: boolean
  ): Promise<DesktopShutdownResult> {
    const results = await Promise.all(sessions.map(session =>
      this.useFallbackForSession(session, deadlineAt, takeoverPendingTerminal)));
    if (results.every(result => result.status === "fallback")) {
      return { status: "fallback" };
    }
    if (results.some(result => result.status === "fallback-failed")) {
      return results.find(result => result.status === "fallback-failed")!;
    }
    return { status: "no-bearer" };
  }

  private async useFallbackForSession(
    session: DesktopShutdownSession,
    deadlineAt: number,
    takeoverPendingTerminal: boolean
  ): Promise<DesktopShutdownResult> {
    if (session === undefined || typeof session.bearer !== "string" || session.bearer.length < 32) {
      return { status: "no-bearer" };
    }
    const fallbackSession: DesktopShutdownFallbackSession = {
      ...session,
      bearer: session.bearer,
      reason: "desktop-quit-main-fallback",
      status: "disconnected",
    };
    const pendingTerminalIdempotencyKey =
      this.dependencies.getPendingTerminalIdempotencyKey?.(session.sessionId);
    const pendingTerminalIntent = this.dependencies.getPendingTerminalIntent?.(session.sessionId);
    if (pendingTerminalIdempotencyKey !== undefined) {
      fallbackSession.idempotencyKey = pendingTerminalIdempotencyKey;
    }
    if (pendingTerminalIntent !== undefined) {
      fallbackSession.terminalIntent = pendingTerminalIntent;
    }
    if (takeoverPendingTerminal && pendingTerminalIdempotencyKey !== undefined
      && pendingTerminalIntent !== undefined) {
      fallbackSession.takeoverPendingTerminal = true;
      fallbackSession.reason = pendingTerminalIntent.reason;
      fallbackSession.status = pendingTerminalIntent.status;
    }
    try {
      const fallbackResult = await this.withDeadline(
        this.dependencies.fallbackMainSession(fallbackSession),
        deadlineAt);
      if (!fallbackResult.completed) {
        return { status: "fallback-failed", errorCode: "SHUTDOWN_TIMEOUT" };
      }
      this.dependencies.clearSession?.(session.sessionId);
      return { status: "fallback" };
    } catch {
      return { status: "fallback-failed", errorCode: "BACKEND_UNAVAILABLE" };
    }
  }

  private async cleanup(deadlineAt: number): Promise<boolean> {
    if (this.cleanupStarted) {
      return true;
    }
    this.cleanupStarted = true;
    let completed = true;
    try {
      if (!(await this.runCleanupHook(this.dependencies.stopWake, deadlineAt)).completed) {
        completed = false;
      }
    } catch {
      // Continue closing the remaining owned resources.
      completed = false;
    }
    try {
      if (!(await this.runCleanupHook(this.dependencies.stopSignalR, deadlineAt)).completed) {
        completed = false;
      }
    } catch {
      // Continue closing windows even if SignalR is already unavailable.
      completed = false;
    }
    try {
      this.dependencies.closeWindows();
    } catch {
      // Electron window destruction is best effort during process shutdown.
    }
    return completed;
  }

  private async runCleanupHook(
    hook: () => Promise<void> | void,
    deadlineAt: number
  ): Promise<{ completed: true } | { completed: false }> {
    const value = hook();
    if (!isPromiseLike(value)) {
      return { completed: true };
    }
    return await this.withDeadline(value, deadlineAt);
  }

  private async withDeadline<T>(operation: Promise<T>, deadlineAt: number): Promise<{
    completed: true;
    value: T;
  } | {
    completed: false;
  }> {
    const remainingMs = Math.max(0, deadlineAt - monotonicNow());
    if (remainingMs === 0) {
      void operation.catch(() => undefined);
      return { completed: false };
    }

    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<{ completed: false }>(resolve => {
      timer = setTimeout(() => resolve({ completed: false }), remainingMs);
      timer.unref?.();
    });
    const result = await Promise.race([
      operation.then(value => ({ completed: true as const, value })),
      timeout
    ]);
    if (timer) {
      clearTimeout(timer);
    }
    if (!result.completed) {
      void operation.catch(() => undefined);
    }
    return result;
  }
}

function monotonicNow(): number {
  return typeof performance !== "undefined" && typeof performance.now === "function"
    ? performance.now()
    : Date.now();
}

function isPromiseLike(value: unknown): value is Promise<unknown> {
  return typeof value === "object" && value !== null
    && "then" in value && typeof value.then === "function";
}

function isUuid(value: unknown): value is string {
  return typeof value === "string" && uuidPattern.test(value);
}

function isValidSession(value: DesktopShutdownSession): boolean {
  return isUuid(value.sessionId)
    && typeof value.externalSessionId === "string"
    && value.externalSessionId.trim().length > 0
    && value.externalSessionId.length <= 200
    && (value.bearer === undefined
      || typeof value.bearer === "string" && value.bearer.length >= 32);
}

function sameConnectionIntent(
  left: DesktopPendingConnectionIntent,
  right: DesktopPendingConnectionIntent
): boolean {
  return left.sessionId === right.sessionId
    && left.externalSessionId === right.externalSessionId
    && left.idempotencyKey === right.idempotencyKey
    && left.bearer === right.bearer;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
