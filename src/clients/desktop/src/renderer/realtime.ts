import {
  RealtimeSession,
  type RealtimeSessionOptions,
  SessionRotationStateMachine,
  createRealtimeAgent,
  mapRealtimeConnectionError,
  sendTypedMessage,
  type RealtimeTaskBackend,
  type NormalizedRealtimeEvent
} from "@jarvis/realtime-agent";
import {
  OpenAIRealtimeWebRTC,
  type RealtimeTransportLayer
} from "@openai/agents-realtime";
import type { WakeWordDetector } from "./wake-word.js";

export interface DesktopRealtimeBackend {
  markConnected: (input: {
    sessionId: string;
    externalSessionId: string;
    idempotencyKey: string;
  }) => Promise<unknown>;
  markEnded: (input: {
    sessionId: string;
    reason: string;
    status: "rotated" | "disconnected" | "failed";
    idempotencyKey: string;
  }) => Promise<unknown>;
  ingest: (input: {
    conversationId: string;
    events: NormalizedRealtimeEvent[];
    idempotencyKey: string;
  }) => Promise<unknown>;
  delegateTask?: RealtimeTaskBackend["delegateTask"];
  getTaskStatus?: RealtimeTaskBackend["getTaskStatus"];
  cancelTask?: RealtimeTaskBackend["cancelTask"];
  rememberFact?: RealtimeTaskBackend["rememberFact"];
}

export type RealtimeTaskStatusResponse = {
  taskId: string;
  status: string;
  progressSummary: string | null;
  requiresUserAction: boolean;
};

export type RealtimeCancelResponse = {
  accepted: boolean;
  status: string;
};

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function responseRecord(value: unknown, message: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(message);
  }
  return value as Record<string, unknown>;
}

function responseString(value: unknown, message: string, maxLength = 200): string {
  if (typeof value !== "string" || value.trim().length === 0 || value.length > maxLength) {
    throw new Error(message);
  }
  return value.trim();
}

function responseStatus(value: unknown, message: string): string {
  return responseString(value, message, 100);
}

function realtimeResponseId(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const responseId = value.trim();
  return responseId.length > 0 && responseId.length <= 200 ? responseId : undefined;
}

function responseIdFromTurnStarted(event: unknown): string | undefined {
  if (typeof event !== "object" || event === null) {
    return undefined;
  }
  const providerData = (event as { providerData?: unknown }).providerData;
  if (typeof providerData !== "object" || providerData === null) {
    return undefined;
  }
  const response = (providerData as { response?: unknown }).response;
  if (typeof response !== "object" || response === null) {
    return undefined;
  }
  return realtimeResponseId((response as { id?: unknown }).id);
}

function responseIdFromDelta(event: unknown): string | undefined {
  if (typeof event !== "object" || event === null) {
    return undefined;
  }
  return realtimeResponseId((event as { responseId?: unknown }).responseId);
}

function responseIdFromTurnDone(event: unknown): string | undefined {
  if (typeof event !== "object" || event === null) {
    return undefined;
  }
  const response = (event as { response?: unknown }).response;
  if (typeof response !== "object" || response === null) {
    return undefined;
  }
  return realtimeResponseId((response as { id?: unknown }).id);
}

export function mapRealtimeTaskStatusResponse(value: unknown): RealtimeTaskStatusResponse {
  const message = "Invalid Realtime task status response.";
  const item = responseRecord(value, message);
  const rawTaskId = item.taskId ?? item.id;
  if (typeof rawTaskId !== "string" || !uuidPattern.test(rawTaskId)) {
    throw new Error(message);
  }

  const status = responseStatus(item.status, message);
  const progressSummary = item.progressSummary;
  if (progressSummary !== undefined
    && progressSummary !== null
    && (typeof progressSummary !== "string" || progressSummary.length > 2_000)) {
    throw new Error(message);
  }

  const normalizedStatus = status.toLowerCase();
  return {
    taskId: rawTaskId,
    status,
    progressSummary: progressSummary === undefined || progressSummary === null ? null : progressSummary,
    requiresUserAction: normalizedStatus === "waitingforapproval"
      || normalizedStatus === "waitingforuserinput"
  };
}

export function mapRealtimeCancelResponse(value: unknown): RealtimeCancelResponse {
  const message = "Invalid Realtime cancellation response.";
  const item = responseRecord(value, message);
  if (typeof item.accepted !== "boolean") {
    throw new Error(message);
  }

  return {
    accepted: item.accepted,
    status: responseStatus(item.status, message)
  };
}

export type DesktopRealtimeStatus = "disconnected" | "connecting" | "connected" | "degraded";

export type DesktopRealtimeWakeState = "standby" | "awake" | "error";

export type DesktopRealtimePersistenceRetryReason = "event-ingest" | "session-end";

export type DesktopRealtimeConnectionInput = {
  realtimeSessionId: string;
  clientSecret: string;
  webRtcUrl?: string;
  model: string;
  voice: string;
  instructions: string;
  mediaStream?: MediaStream;
};

export type DesktopRealtimeSessionFactory = (
  agent: ReturnType<typeof createRealtimeAgent>,
  options: Partial<RealtimeSessionOptions>
) => RealtimeSession;

export type DesktopRealtimeTransportFactory = (mediaStream: MediaStream) => RealtimeTransportLayer;

type PreparedRealtimeSession = {
  session: RealtimeSession;
  sessionId: string;
  externalSessionId: string;
  generation: number;
};

type PendingRealtimeBatch = {
  events: NormalizedRealtimeEvent[];
  idempotencyKey: string;
};

type PendingSessionEnd = {
  sessionId: string;
  reason: string;
  status: "rotated" | "disconnected" | "failed";
  idempotencyKey: string;
};

const actualSessionIdTimeoutMs = 500;

export class DesktopRealtimeController {
  private session: RealtimeSession | undefined;
  private sessionId: string | undefined;
  private externalSessionId: string | undefined;
  private readonly rotation = new SessionRotationStateMachine();
  private readonly textByItem = new Map<string, string>();
  private readonly modalityByItem = new Map<string, "text" | "audioWithTranscript">();
  private readonly pendingBatches: PendingRealtimeBatch[] = [];
  private eventIngestPersistenceFailed = false;
  private pendingSessionEnd: PendingSessionEnd | undefined;
  private persistenceTimer: ReturnType<typeof setTimeout> | undefined;
  private persistenceFlush: Promise<boolean> | undefined;
  private rotationTimer: ReturnType<typeof setInterval> | undefined;
  private statusValue: DesktopRealtimeStatus = "disconnected";
  private connectionGeneration = 0;
  private nextConnectionGeneration = 0;
  private readonly pendingAudioInterruptions = new WeakSet<RealtimeSession>();
  private readonly interruptedItems = new WeakMap<RealtimeSession, Set<string>>();
  private wakeWordDetector: WakeWordDetector | undefined;
  private removeWakeWordDetection: (() => void) | undefined;
  private removeWakeWordState: (() => void) | undefined;
  private wakeWordStarted = false;
  private wakeStateValue: DesktopRealtimeWakeState = "standby";
  private activeWakeResponseId: string | undefined;
  private realtimeMediaStream: MediaStream | undefined;
  private onWakeStateChange: ((state: DesktopRealtimeWakeState) => void) | undefined;
  private rotationProvider: (() => Promise<{
    realtimeSessionId: string;
    clientSecret: string;
    webRtcUrl?: string;
    model: string;
    voice: string;
    instructions: string;
  }>) | undefined;

  public constructor(
    private readonly conversationId: string,
    private readonly backend: DesktopRealtimeBackend,
    private readonly onStatus: (status: DesktopRealtimeStatus, error?: string) => void,
    private readonly now: () => number = () => Date.now(),
    private readonly createSession: DesktopRealtimeSessionFactory = (agent, options) => new RealtimeSession(agent, options),
    private readonly createTransport: DesktopRealtimeTransportFactory = mediaStream =>
      new OpenAIRealtimeWebRTC({ mediaStream })
  ) {}

  public get status(): DesktopRealtimeStatus {
    return this.statusValue;
  }

  public get realtimeSessionId(): string | undefined {
    return this.sessionId;
  }

  public get wakeState(): DesktopRealtimeWakeState {
    return this.wakeStateValue;
  }

  public get persistenceRetryReason(): DesktopRealtimePersistenceRetryReason | undefined {
    if (this.eventIngestPersistenceFailed) {
      return "event-ingest";
    }
    return this.pendingSessionEnd ? "session-end" : undefined;
  }

  public setWakeWordDetector(
    detector: WakeWordDetector,
    onWakeStateChange?: (state: DesktopRealtimeWakeState) => void
  ): void {
    this.removeWakeWordDetection?.();
    this.removeWakeWordState?.();
    this.wakeWordDetector = detector;
    this.removeWakeWordDetection = detector.onDetected(() => this.wake());
    this.removeWakeWordState = detector.onStateChange(state => {
      if (state === "error") {
        // The Main process has already stopped the native detector before
        // publishing this state. Mark the local lifecycle as restartable
        // without allowing audio to remain open during the retry.
        this.wakeWordStarted = false;
        this.failClosedAudio(this.session, "error");
        this.onStatus(this.statusValue, "本地中文唤醒词检测不可用，请检查模型文件和麦克风权限。");
      }
    });
    this.onWakeStateChange = onWakeStateChange;
    onWakeStateChange?.(this.wakeStateValue);
  }

  public setRotationProvider(
    provider: () => Promise<{
      realtimeSessionId: string;
      clientSecret: string;
      webRtcUrl?: string;
      model: string;
      voice: string;
      instructions: string;
    }>
  ): void {
    this.rotationProvider = provider;
  }

  public async connect(input: DesktopRealtimeConnectionInput): Promise<void> {
    if (!input.clientSecret || !input.realtimeSessionId || !input.instructions.trim()) {
      throw new Error("A realtime session id, instructions, and ephemeral client secret are required.");
    }
    if (input.mediaStream && !this.wakeWordDetector) {
      throw new Error("A local wake word detector is required before opening the realtime microphone.");
    }

    if (input.mediaStream) {
      this.realtimeMediaStream = input.mediaStream;
    }

    const previousSession = this.session;
    const previousSessionId = this.sessionId;
    const previousStatus = this.statusValue;
    this.statusValue = "connecting";
    this.onStatus(this.statusValue);

    try {
      const prepared = await this.prepareSession(input);
      this.activate(prepared);
    } catch (error) {
      const mapped = mapRealtimeConnectionError(error);
      if (previousSession && previousSessionId) {
        // prepareSession never mutates the active connection, so this is a
        // true state-preserving failure path rather than a restore-after-swap.
        this.statusValue = previousStatus;
        if (previousStatus === "connected") {
          this.startRotationTimer();
        }
      } else {
        this.stopRotationTimer();
        this.session = undefined;
        this.sessionId = undefined;
        this.externalSessionId = undefined;
        this.rotation.disconnected();
        this.statusValue = "degraded";
        await this.releaseAudioResources();
      }
      this.onStatus(this.statusValue, mapped.message);
      throw error;
    }
  }

  private async prepareSession(input: DesktopRealtimeConnectionInput): Promise<PreparedRealtimeSession> {
    const generation = ++this.nextConnectionGeneration;
    const mediaStream = input.mediaStream ?? this.realtimeMediaStream;
    if (mediaStream) {
      this.setMediaStreamEnabled(mediaStream, false);
    }
    const taskBackend = this.backend.delegateTask
      && this.backend.getTaskStatus
      && this.backend.cancelTask
      && this.backend.rememberFact
      ? {
          delegateTask: this.backend.delegateTask,
          getTaskStatus: this.backend.getTaskStatus,
          cancelTask: this.backend.cancelTask,
          rememberFact: this.backend.rememberFact
        }
      : undefined;
    const session = this.createSession(createRealtimeAgent(input.instructions, input.voice, {
      backend: taskBackend,
      sessionScope: input.realtimeSessionId
    }), {
      transport: mediaStream ? this.createTransport(mediaStream) : "webrtc",
      model: input.model,
      historyStoreAudio: false,
      tracingDisabled: true,
      config: {
        audio: {
          input: {
            transcription: { model: "gpt-4o-mini-transcribe" },
            turnDetection: { type: "server_vad", createResponse: true, interruptResponse: true }
          },
          output: { voice: input.voice }
        }
      }
    });
    this.bindTransport(session, generation, input.realtimeSessionId);
    const actualSessionId = new Promise<string>(resolve => {
      session.transport.on("*", event => {
        if (event.type !== "session.created" || typeof event.session?.id !== "string") {
          return;
        }

        const value = event.session.id.trim();
        if (value) {
          resolve(value);
        }
      });
    });

    try {
      await session.connect({
        apiKey: input.clientSecret,
        model: input.model,
        ...(input.webRtcUrl ? { url: input.webRtcUrl } : {})
      });
      if (mediaStream) {
        session.mute(true);
      }
      let timeout: ReturnType<typeof setTimeout> | undefined;
      let actualExternalSessionId: string;
      try {
        actualExternalSessionId = await Promise.race([
          actualSessionId,
          new Promise<never>((_, reject) => {
            timeout = setTimeout(
              () => reject(new Error("Realtime connection did not provide the actual WebRTC session id.")),
              actualSessionIdTimeoutMs);
          })
        ]);
      } finally {
        if (timeout) {
          clearTimeout(timeout);
        }
      }
      await this.backend.markConnected({
        sessionId: input.realtimeSessionId,
        externalSessionId: actualExternalSessionId,
        idempotencyKey: crypto.randomUUID()
      });
      await this.startWakeWordDetector();
      return {
        session,
        sessionId: input.realtimeSessionId,
        externalSessionId: actualExternalSessionId,
        generation
      };
    } catch (error) {
      session.close();
      await this.markFailed(input.realtimeSessionId, "connection-failed");
      throw error;
    }
  }

  private activate(prepared: PreparedRealtimeSession): void {
    // The generation is switched before the object references so stale old
    // transport callbacks are rejected during the tiny swap window.
    this.connectionGeneration = prepared.generation;
    this.session = prepared.session;
    this.sessionId = prepared.sessionId;
    this.externalSessionId = prepared.externalSessionId;
    this.activeWakeResponseId = undefined;
    this.textByItem.clear();
    this.modalityByItem.clear();
    this.rotation.connected(this.now());
    this.setWakeState("standby");
    if (this.realtimeMediaStream) {
      this.setMediaStreamEnabled(this.realtimeMediaStream, false);
      prepared.session.mute(true);
    }
    this.statusValue = "connected";
    this.onStatus(this.statusValue);
    this.startRotationTimer();
  }

  public async sendTyped(text: string, persist: (text: string) => Promise<unknown>): Promise<void> {
    if (!this.session || !this.sessionId) {
      throw new Error("Realtime is not connected.");
    }

    await sendTypedMessage(this.session, text, persist);
    this.rotation.activity(this.now());
  }

  public async flushPendingPersistence(): Promise<boolean> {
    while (true) {
      if (this.persistenceTimer) {
        clearTimeout(this.persistenceTimer);
        this.persistenceTimer = undefined;
      }

      const inFlight = this.persistenceFlush;
      if (inFlight) {
        if (!await inFlight) {
          return false;
        }
      } else {
        const flush = this.flushBatches();
        this.persistenceFlush = flush;
        try {
          if (!await flush) {
            return false;
          }
        } finally {
          if (this.persistenceFlush === flush) {
            this.persistenceFlush = undefined;
          }
        }
      }

      // A transport callback can enqueue another batch while the previous
      // request is resolving. Never let rotation observe a false-empty queue.
      await Promise.resolve();
      if (this.pendingBatches.length === 0) {
        return true;
      }
    }
  }

  public async retryPersistence(): Promise<boolean> {
    if (!await this.flushPendingPersistence() || !await this.retryPendingSessionEnd()) {
      return false;
    }

    if (this.statusValue === "degraded") {
      this.statusValue = this.session ? "connected" : "disconnected";
      this.onStatus(this.statusValue);
      if (this.session) {
        this.startRotationTimer();
      }
    }

    return true;
  }

  public setMicrophoneMuted(muted: boolean): void {
    if (!this.realtimeMediaStream) {
      this.session?.mute(muted);
      if (muted) {
        this.setWakeState("standby");
      }
      return;
    }

    if (muted) {
      this.setWakeState("standby");
      this.setMediaStreamEnabled(this.realtimeMediaStream, false);
      this.session?.mute(true);
      return;
    }

    if (this.wakeStateValue === "awake") {
      this.setMediaStreamEnabled(this.realtimeMediaStream, true);
      this.session?.mute(false);
    }
  }

  public wake(): void {
    if (this.statusValue !== "connected" || !this.session) {
      return;
    }
    if (this.wakeStateValue !== "standby") {
      return;
    }

    this.activeWakeResponseId = undefined;
    this.setWakeState("awake");
    this.setMediaStreamEnabled(this.realtimeMediaStream, true);
    this.session.mute(false);
  }

  public async retryWakeWord(): Promise<void> {
    if (this.statusValue !== "connected" || !this.session) {
      throw new Error("Realtime is not connected.");
    }
    if (!this.wakeWordDetector) {
      throw new Error("Local wake-word detector is not configured.");
    }
    if (this.wakeWordStarted && this.wakeStateValue !== "error") {
      return;
    }

    this.failClosedAudio(this.session, "error");
    try {
      await this.startWakeWordDetector();
      this.setWakeState("standby");
    } catch {
      this.failClosedAudio(this.session, "error");
      const message = "本地中文唤醒词检测不可用，请检查模型文件和麦克风权限后重试。";
      this.onStatus(this.statusValue, message);
      throw new Error(message);
    }
  }

  public interrupt(): void {
    const session = this.session;
    this.failClosedAudio(session);
    session?.interrupt();
  }

  public async disconnect(reason = "user-disconnected"): Promise<boolean> {
    this.stopRotationTimer();
    this.failClosedAudio(this.session);
    if (!await this.flushPendingPersistence() || !await this.retryPendingSessionEnd()) {
      this.statusValue = "degraded";
      this.onStatus(
        this.statusValue,
        this.session
          ? "Message persistence failed; the realtime session remains connected for retry."
          : "Message persistence failed; retry is required before the session can finish disconnecting."
      );
      if (this.session) {
        this.startRotationTimer();
      }
      return false;
    }

    this.connectionGeneration = ++this.nextConnectionGeneration;
    const session = this.session;
    const sessionId = this.sessionId;
    this.session = undefined;
    this.sessionId = undefined;
    this.externalSessionId = undefined;
    this.rotation.disconnected();
    if (session) {
      session.close();
    }
    await this.releaseAudioResources();
    if (sessionId) {
      const pendingEnd: PendingSessionEnd = {
        sessionId,
        reason,
        status: "disconnected",
        idempotencyKey: crypto.randomUUID()
      };
      try {
        await this.backend.markEnded(pendingEnd);
      } catch (error) {
        this.pendingSessionEnd = pendingEnd;
        this.statusValue = "degraded";
        this.onStatus(this.statusValue, mapRealtimeConnectionError(error).message);
        if (this.session) {
          this.startRotationTimer();
        }
        return false;
      }
    }
    this.statusValue = "disconnected";
    this.onStatus(this.statusValue);
    return true;
  }

  private bindTransport(session: RealtimeSession, generation: number, boundSessionId: string): void {
    const isCurrent = (): boolean => this.isCurrent(session, generation, boundSessionId);
    session.transport.on("turn_started", event => {
      if (!isCurrent() || this.wakeStateValue !== "awake") {
        return;
      }
      this.activeWakeResponseId = responseIdFromTurnStarted(event);
    });
    session.transport.on("connection_change", status => {
      if (isCurrent() && status === "disconnected" && this.statusValue === "connected") {
        this.failClosedAudio(session);
        const droppedSessionId = boundSessionId;
        this.session = undefined;
        this.sessionId = undefined;
        this.externalSessionId = undefined;
        this.stopRotationTimer();
        this.rotation.disconnected();
        this.statusValue = "degraded";
        void this.releaseAudioResources();
        this.onStatus(this.statusValue, "Realtime connection was interrupted.");
        if (droppedSessionId) {
          void this.markFailed(droppedSessionId, "connection-lost");
        }
      }
    });
    session.transport.on("error", event => {
      if (isCurrent() && this.statusValue === "connected") {
        this.failClosedAudio(session);
        const droppedSessionId = boundSessionId;
        this.session = undefined;
        this.sessionId = undefined;
        this.externalSessionId = undefined;
        this.stopRotationTimer();
        this.rotation.disconnected();
        const mapped = mapRealtimeConnectionError(event.error);
        this.statusValue = "degraded";
        void this.releaseAudioResources();
        this.onStatus(this.statusValue, mapped.message);
        if (droppedSessionId) {
          void this.markFailed(droppedSessionId, "transport-error");
        }
      }
    });
    session.transport.on("*", event => {
      if (!isCurrent()) {
        return;
      }

      if (event.type === "input_audio_buffer.speech_started") {
        this.rotation.setUserSpeaking(true, this.now());
      }

      if (event.type === "input_audio_buffer.speech_stopped") {
        this.rotation.setUserSpeaking(false, this.now());
      }

      if (event.type === "conversation.item.input_audio_transcription.completed") {
        this.queuePersist({
          version: 1,
          eventId: crypto.randomUUID(),
          externalItemId: event.item_id,
          realtimeSessionId: boundSessionId,
          role: "user",
          modality: "voice",
          status: "completed",
          text: event.transcript
        });
        this.rotation.setUserSpeaking(false, this.now());
      }
    });
    session.transport.on("audio_transcript_delta", event => {
      if (!isCurrent()) {
        return;
      }
      const responseId = responseIdFromDelta(event);
      if (this.wakeStateValue === "awake" && responseId && !this.activeWakeResponseId) {
        this.activeWakeResponseId = responseId;
      }
      this.appendText(event.itemId, event.delta);
      this.modalityByItem.set(event.itemId, "audioWithTranscript");
      this.queuePersist({
        version: 1,
        eventId: crypto.randomUUID(),
        externalItemId: event.itemId,
        realtimeSessionId: boundSessionId,
        role: "assistant",
        modality: "audioWithTranscript",
        status: "streaming",
        text: this.textByItem.get(event.itemId)
      });
      this.rotation.setAssistantSpeaking(true, this.now());
    });
    session.transport.on("audio", () => {
      if (!isCurrent()) {
        return;
      }
      this.rotation.setAssistantSpeaking(true, this.now());
    });
    session.transport.on("audio_done", () => {
      if (!isCurrent()) {
        return;
      }
      this.rotation.setAssistantSpeaking(false, this.now());
    });
    session.transport.on("output_text_delta", event => {
      if (!isCurrent()) {
        return;
      }
      const responseId = responseIdFromDelta(event);
      if (this.wakeStateValue === "awake" && responseId && !this.activeWakeResponseId) {
        this.activeWakeResponseId = responseId;
      }
      this.appendText(event.itemId, event.delta);
      this.modalityByItem.set(event.itemId, "text");
      this.queuePersist({
        version: 1,
        eventId: crypto.randomUUID(),
        externalItemId: event.itemId,
        realtimeSessionId: boundSessionId,
        role: "assistant",
        modality: "text",
        status: "streaming",
        text: this.textByItem.get(event.itemId)
      });
      this.rotation.setAssistantSpeaking(true, this.now());
    });
    session.transport.on("turn_done", event => {
      if (!isCurrent()) {
        return;
      }
      const outputItems = event.response?.output;
      const itemId = Array.isArray(outputItems)
        ? [...outputItems].reverse().find(item => typeof item?.id === "string")?.id
        : undefined;
      const completedItemId = itemId ?? [...this.textByItem.keys()].at(-1);
      if (completedItemId) {
        this.queuePersist({
          version: 1,
          eventId: crypto.randomUUID(),
          externalItemId: completedItemId,
          realtimeSessionId: boundSessionId,
          role: "assistant",
          modality: this.modalityByItem.get(completedItemId) ?? "text",
          status: "completed",
          text: this.textByItem.get(completedItemId)
        });
      }
      this.rotation.setAssistantSpeaking(false, this.now());
      const doneResponseId = responseIdFromTurnDone(event);
      const matchesActiveWakeResponse = this.activeWakeResponseId
        ? doneResponseId === this.activeWakeResponseId
        : doneResponseId === undefined;
      if (this.wakeStateValue === "awake" && matchesActiveWakeResponse) {
        this.activeWakeResponseId = undefined;
        this.setWakeState("standby");
        this.setMediaStreamEnabled(this.realtimeMediaStream, false);
        session.mute(true);
      }
    });
    session.transport.on("audio_interrupted", () => {
      if (isCurrent()) {
        this.failClosedAudio(session);
        this.rotation.setAssistantSpeaking(false, this.now());
      }
    });
    session.on("audio_interrupted", () => {
      if (!isCurrent()) {
        return;
      }

      this.failClosedAudio(session);
      this.pendingAudioInterruptions.add(session);
      if (this.persistInterruptedFromHistory(session, boundSessionId, session.history)) {
        this.pendingAudioInterruptions.delete(session);
      }
      this.rotation.setAssistantSpeaking(false, this.now());
    });
    session.on("history_updated", history => {
      if (!isCurrent() || !this.pendingAudioInterruptions.has(session)) {
        return;
      }

      if (this.persistInterruptedFromHistory(session, boundSessionId, history)) {
        this.pendingAudioInterruptions.delete(session);
      }
    });
  }

  private appendText(itemId: string, delta: string): void {
    this.textByItem.set(itemId, `${this.textByItem.get(itemId) ?? ""}${delta}`);
  }

  private async startWakeWordDetector(): Promise<void> {
    if (!this.wakeWordDetector || this.wakeWordStarted) {
      return;
    }

    const detector = this.wakeWordDetector;
    await detector.start();
    if (detector.state !== "listening") {
      throw new Error("Local wake-word detector did not enter listening state.");
    }
    this.wakeWordStarted = true;
  }

  private async releaseAudioResources(): Promise<void> {
    const detector = this.wakeWordDetector;
    if (detector && this.wakeWordStarted) {
      try {
        await detector.stop();
      } catch (error) {
        this.onStatus(
          this.statusValue,
          error instanceof Error ? error.message : "Local wake word detector could not be stopped.");
      }
    }
    this.wakeWordStarted = false;
    this.removeWakeWordDetection?.();
    this.removeWakeWordState?.();
    this.removeWakeWordDetection = undefined;
    this.removeWakeWordState = undefined;
    this.wakeWordDetector = undefined;
    this.activeWakeResponseId = undefined;

    const mediaStream = this.realtimeMediaStream;
    this.realtimeMediaStream = undefined;
    this.setMediaStreamEnabled(mediaStream, false);
    for (const track of mediaStream?.getTracks() ?? []) {
      track.stop();
    }
    this.setWakeState("standby");
  }

  private setMediaStreamEnabled(mediaStream: MediaStream | undefined, enabled: boolean): void {
    for (const track of mediaStream?.getTracks() ?? []) {
      track.enabled = enabled;
    }
  }

  private failClosedAudio(
    session: RealtimeSession | undefined,
    nextWakeState: DesktopRealtimeWakeState = "standby"
  ): void {
    this.activeWakeResponseId = undefined;
    this.setWakeState(nextWakeState);
    if (!this.realtimeMediaStream) {
      return;
    }

    this.setMediaStreamEnabled(this.realtimeMediaStream, false);
    session?.mute(true);
  }

  private setWakeState(state: DesktopRealtimeWakeState): void {
    if (this.wakeStateValue === state) {
      return;
    }
    this.wakeStateValue = state;
    this.onWakeStateChange?.(state);
  }

  private isCurrent(session: RealtimeSession, generation: number, sessionId: string): boolean {
    return this.connectionGeneration === generation
      && this.session === session
      && this.sessionId === sessionId;
  }

  private persistInterruptedFromHistory(
    session: RealtimeSession,
    sessionId: string,
    history: readonly unknown[]
  ): boolean {
    const interrupted = [...history].reverse().find(item => {
      if (typeof item !== "object" || item === null) {
        return false;
      }

      const candidate = item as { type?: unknown; role?: unknown; status?: unknown };
      return candidate.type === "message"
        && candidate.role === "assistant"
        && candidate.status === "incomplete";
    }) as {
      itemId?: unknown;
      content?: readonly unknown[];
    } | undefined;
    if (!interrupted || typeof interrupted.itemId !== "string" || !Array.isArray(interrupted.content)) {
      return false;
    }

    const itemId = interrupted.itemId;
    const persisted = this.interruptedItems.get(session) ?? new Set<string>();
    if (persisted.has(itemId)) {
      return true;
    }

    let text: string | undefined;
    let modality: "audioWithTranscript" | "text" = "audioWithTranscript";
    for (const content of interrupted.content) {
      if (typeof content !== "object" || content === null) {
        continue;
      }

      const part = content as { type?: unknown; transcript?: unknown; text?: unknown };
      if (part.type === "output_audio" && typeof part.transcript === "string") {
        text = part.transcript;
        modality = "audioWithTranscript";
        break;
      }

      if (part.type === "output_text" && typeof part.text === "string") {
        text = part.text;
        modality = "text";
      }
    }
    if (text === undefined) {
      // Delta text is only a live preview. Do not turn it into a terminal
      // interrupted message until the SDK history confirms the item content.
      return false;
    }

    persisted.add(itemId);
    this.interruptedItems.set(session, persisted);
    this.queuePersist({
      version: 1,
      eventId: crypto.randomUUID(),
      externalItemId: itemId,
      realtimeSessionId: sessionId,
      role: "assistant",
      modality,
      status: "interrupted",
      text
    });
    return true;
  }

  private async persistEvent(event: NormalizedRealtimeEvent): Promise<void> {
    const lastBatch = this.pendingBatches.at(-1);
    if (lastBatch && lastBatch.events.length < 100) {
      lastBatch.events.push(event);
    } else {
      this.pendingBatches.push({
        events: [event],
        idempotencyKey: crypto.randomUUID()
      });
    }
    this.schedulePersistenceFlush();
  }

  private async markFailed(sessionId: string, reason: string): Promise<void> {
    const pendingEnd: PendingSessionEnd = {
      sessionId,
      reason,
      status: "failed",
      idempotencyKey: crypto.randomUUID()
    };
    try {
      await this.backend.markEnded(pendingEnd);
    } catch (error) {
      this.pendingSessionEnd ??= pendingEnd;
      this.onStatus(this.statusValue, error instanceof Error ? error.message : "Realtime failure could not be persisted.");
    }
  }

  private queuePersist(event: NormalizedRealtimeEvent): void {
    void this.persistEvent(event);
  }

  private schedulePersistenceFlush(): void {
    if (this.persistenceTimer) {
      return;
    }

    this.persistenceTimer = setTimeout(() => {
      this.persistenceTimer = undefined;
      void this.flushPendingPersistence();
    }, 25);
  }

  private async flushBatches(): Promise<boolean> {
    while (true) {
      while (this.pendingBatches.length > 0) {
        const batch = this.pendingBatches.shift()!;
        try {
          await this.backend.ingest({
            conversationId: this.conversationId,
            events: batch.events,
            idempotencyKey: batch.idempotencyKey
          });
        } catch (error) {
          this.pendingBatches.unshift(batch);
          this.eventIngestPersistenceFailed = true;
          this.onStatus(
            this.statusValue,
            error instanceof Error ? error.message : "Message persistence failed."
          );
          return false;
        }
      }

      // Let events queued by a transport callback that ran while the final
      // request resolved enter the queue before declaring the flush complete.
      await Promise.resolve();
      if (this.pendingBatches.length === 0) {
        const recoveredEventIngest = this.eventIngestPersistenceFailed;
        this.eventIngestPersistenceFailed = false;
        if (recoveredEventIngest) {
          this.onStatus(this.statusValue);
        }
        return true;
      }
    }
  }

  private startRotationTimer(): void {
    this.stopRotationTimer();
    this.rotationTimer = setInterval(() => {
      void this.rotateIfIdle();
    }, 15_000);
  }

  public async rotateIfIdle(): Promise<void> {
    if (!await this.retryPendingSessionEnd()) {
      return;
    }

    if (this.rotation.tick(this.now()) !== "rotation-ready" || !this.rotation.canRotate()) {
      return;
    }

    if (this.rotationProvider) {
      await this.rotate();
    } else {
      this.onStatus(this.statusValue, "Realtime session is ready for idle rotation.");
    }
  }

  private stopRotationTimer(): void {
    if (this.rotationTimer) {
      clearInterval(this.rotationTimer);
      this.rotationTimer = undefined;
    }
  }

  private async rotate(): Promise<void> {
    if (!this.rotationProvider || !this.rotation.canRotate() || !this.sessionId) {
      return;
    }

    const oldSessionId = this.sessionId;
    const oldSession = this.session;
    this.failClosedAudio(oldSession);
    let nextSession: DesktopRealtimeConnectionInput;
    try {
      // Context assembly happens on the backend, so all transcript writes from
      // the old session must be accepted before requesting the next secret.
      if (!await this.flushPendingPersistence()) {
        this.startRotationTimer();
        return;
      }
      nextSession = await this.rotationProvider();
    } catch (error) {
      const mapped = mapRealtimeConnectionError(error);
      // Secret/bootstrap failures do not invalidate the active transport.
      this.statusValue = "connected";
      this.startRotationTimer();
      this.onStatus(this.statusValue, mapped.message);
      return;
    }
    if (!this.rotation.consumeRotation()) {
      return;
    }

    this.stopRotationTimer();
    let prepared: PreparedRealtimeSession;
    try {
      // Connect and durably acknowledge the replacement before touching the
      // currently usable session. A failed replacement leaves it untouched.
      prepared = await this.prepareSession(nextSession);
    } catch (error) {
      const mapped = mapRealtimeConnectionError(error);
      // Rotation owns the audio boundary from its first await onward. Keep
      // the old session usable only through a later explicit wake request.
      this.statusValue = "connected";
      this.startRotationTimer();
      this.onStatus(this.statusValue, mapped.message);
      return;
    }

    if (this.session !== oldSession || this.sessionId !== oldSessionId) {
      prepared.session.close();
      await this.markFailed(prepared.sessionId, "rotation-superseded");
      return;
    }

    this.activate(prepared);
    const pendingEnd: PendingSessionEnd = {
      sessionId: oldSessionId,
      reason: "idle-50-minute-rotation",
      status: "rotated",
      idempotencyKey: crypto.randomUUID()
    };
    try {
      await this.backend.markEnded(pendingEnd);
    } catch (error) {
      // The generation was already swapped, so closing the old transport is
      // safe even when its durable terminal update needs a later retry.
      oldSession?.close();
      this.pendingSessionEnd = pendingEnd;
      const mapped = mapRealtimeConnectionError(error);
      this.statusValue = "connected";
      this.startRotationTimer();
      this.onStatus(this.statusValue, mapped.message);
      return;
    }
    oldSession?.close();
  }

  private async retryPendingSessionEnd(): Promise<boolean> {
    const pendingEnd = this.pendingSessionEnd;
    if (!pendingEnd) {
      return true;
    }

    try {
      await this.backend.markEnded(pendingEnd);
      this.pendingSessionEnd = undefined;
      this.onStatus(this.statusValue);
      return true;
    } catch (error) {
      this.onStatus(this.statusValue, mapRealtimeConnectionError(error).message);
      return false;
    }
  }
}
