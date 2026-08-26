import type { RealtimeSession } from "@openai/agents-realtime";
import type { NormalizedRealtimeEvent } from "@jarvis/realtime-agent";
import { createMobileUuid } from "../platform/mobileUuid";

export interface MobileRealtimePersistenceBackend {
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
}

type RawRealtimeEvent = {
  type?: unknown;
  event_id?: unknown;
  item_id?: unknown;
  transcript?: unknown;
  response?: { output?: readonly { id?: unknown }[] };
};

/** Persists text/transcript facts while leaving audio entirely on the native transport. */
export class MobileRealtimeConversationBridge {
  private session: RealtimeSession | undefined;
  private readonly externalSessionId: string;
  private readonly onRawEvent = (event: unknown): void => this.handleRawEvent(event);
  private readonly onAudioTranscriptDelta = (event: unknown): void => {
    const value = asRecord(event) ?? {};
    const itemId = stringValue(value.itemId);
    const delta = stringValue(value.delta);
    if (itemId && delta) {
      this.appendText(itemId, delta);
      this.modalityByItem.set(itemId, "audioWithTranscript");
      this.queuePersist(itemId, "assistant", "audioWithTranscript", "streaming", this.textByItem.get(itemId));
    }
  };
  private readonly onOutputTextDelta = (event: unknown): void => {
    const value = asRecord(event) ?? {};
    const itemId = stringValue(value.itemId);
    const delta = stringValue(value.delta);
    if (itemId && delta) {
      this.appendText(itemId, delta);
      this.modalityByItem.set(itemId, "text");
      this.queuePersist(itemId, "assistant", "text", "streaming", this.textByItem.get(itemId));
    }
  };
  private readonly onTurnDone = (event: unknown): void => {
    const value = asRecord(event) ?? {};
    const output = asRecord(value.response) ?? {};
    const outputItems = Array.isArray(output?.output) ? output.output : [];
    const itemId = [...outputItems].reverse()
      .map(item => stringValue(asRecord(item)?.id))
      .find((candidate): candidate is string => candidate !== undefined)
      ?? [...this.textByItem.keys()].at(-1);
    if (itemId) {
      this.queuePersist(
        itemId,
        "assistant",
        this.modalityByItem.get(itemId) ?? "text",
        "completed",
        this.textByItem.get(itemId));
    }
  };
  private readonly textByItem = new Map<string, string>();
  private readonly modalityByItem = new Map<string, "text" | "audioWithTranscript">();
  private ingestQueue: Promise<void> = Promise.resolve();
  private ingestFailure: unknown;
  private closed = false;
  private connectAttempt = 0;

  public constructor(
    private readonly conversationId: string,
    private readonly realtimeSessionId: string,
    private readonly backend: MobileRealtimePersistenceBackend,
    private readonly idempotencyKey: () => string = () => `mobile-realtime-${createMobileUuid()}`,
    externalSessionId: string = createMobileUuid()
  ) {
    this.externalSessionId = externalSessionId;
  }

  public async connect(session: RealtimeSession): Promise<void> {
    if (this.closed) {
      throw new Error("A closed mobile realtime bridge cannot reconnect.");
    }
    if (this.session) {
      return;
    }

    const attempt = ++this.connectAttempt;
    await this.backend.markConnected({
      sessionId: this.realtimeSessionId,
      externalSessionId: this.externalSessionId,
      idempotencyKey: this.idempotencyKey()
    });
    if (this.closed || this.connectAttempt !== attempt) {
      try {
        session.close();
      } catch {
        // The realtime session may already have been released by the native
        // transport while its lifecycle marker was still in flight.
      }
      throw new Error("A mobile realtime bridge was closed during connection setup.");
    }
    this.session = session;
    session.transport.on("*", this.onRawEvent);
    session.transport.on("audio_transcript_delta", this.onAudioTranscriptDelta);
    session.transport.on("output_text_delta", this.onOutputTextDelta);
    session.transport.on("turn_done", this.onTurnDone);
  }

  public async close(
    reason = "mobile-disconnected",
    status: "rotated" | "disconnected" | "failed" = "disconnected"
  ): Promise<void> {
    if (this.closed) {
      await this.whenIdle();
      return;
    }
    this.closed = true;
    ++this.connectAttempt;
    const session = this.session;
    this.session = undefined;
    if (session) {
      session.transport.off("*", this.onRawEvent);
      session.transport.off("audio_transcript_delta", this.onAudioTranscriptDelta);
      session.transport.off("output_text_delta", this.onOutputTextDelta);
      session.transport.off("turn_done", this.onTurnDone);
      session.close();
    }

    await this.whenIdle();
    await this.backend.markEnded({
      sessionId: this.realtimeSessionId,
      reason,
      status,
      idempotencyKey: this.idempotencyKey()
    });
    if (this.ingestFailure) {
      throw this.ingestFailure;
    }
  }

  public async whenIdle(): Promise<void> {
    await this.ingestQueue;
  }

  private handleRawEvent(event: unknown): void {
    const value = event as RawRealtimeEvent;
    if (value.type !== "conversation.item.input_audio_transcription.completed") {
      return;
    }
    const itemId = stringValue(value.item_id);
    const transcript = stringValue(value.transcript);
    if (itemId && transcript) {
      this.queuePersist(itemId, "user", "voice", "completed", transcript);
    }
  }

  private appendText(itemId: string, delta: string): void {
    this.textByItem.set(itemId, `${this.textByItem.get(itemId) ?? ""}${delta}`);
  }

  private queuePersist(
    itemId: string,
    role: "user" | "assistant",
    modality: NormalizedRealtimeEvent["modality"],
    status: NormalizedRealtimeEvent["status"],
    text?: string
  ): void {
    const event: NormalizedRealtimeEvent = {
      version: 1,
      eventId: createMobileUuid(),
      externalItemId: itemId,
      realtimeSessionId: this.realtimeSessionId,
      role,
      modality,
      status,
      ...(text ? { text } : {}),
      occurredAtMs: Date.now()
    };
    this.ingestQueue = this.ingestQueue
      .catch(() => undefined)
      .then(async () => {
        try {
          await this.backend.ingest({
            conversationId: this.conversationId,
            events: [event],
            idempotencyKey: this.idempotencyKey()
          });
        } catch (error) {
          this.ingestFailure ??= error;
          throw error;
        }
      });
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}
