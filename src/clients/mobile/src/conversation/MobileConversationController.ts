import { createTextOnlyResponseEvent } from "@jarvis/realtime-agent";

export type MobileConversation = { id: string };

export interface MobileConversationBackend {
  createConversation: (title?: string | null) => Promise<MobileConversation>;
  getConversation: (conversationId: string) => Promise<MobileConversation>;
  addTypedMessage: (conversationId: string, request: MobileTypedMessageRequest, idempotencyKey: string) => Promise<unknown>;
}

export type MobileTypedMessageRequest = {
  clientRequestId: string;
  text: string;
  replyMode: "text";
  realtimeSessionId: string | null;
};

export interface MobileVoiceSession {
  interrupt: () => void;
  sendEvent: (event: unknown) => void;
}

/** Binds typed and voice turns to the same persisted conversation. */
export class MobileConversationController {
  private conversationValue: MobileConversation | undefined;
  private voiceSession: MobileVoiceSession | undefined;

  public constructor(
    private readonly backend: MobileConversationBackend,
    private readonly idempotencyKey: () => string
  ) {}

  public get conversationId(): string | undefined {
    return this.conversationValue?.id;
  }

  public attachVoiceSession(session: MobileVoiceSession | undefined): void {
    this.voiceSession = session;
  }

  public async open(conversationId?: string, title?: string | null): Promise<MobileConversation> {
    this.conversationValue = conversationId
      ? await this.backend.getConversation(conversationId)
      : await this.backend.createConversation(title);
    return this.conversationValue;
  }

  public async sendTyped(text: string): Promise<unknown> {
    const conversationId = this.conversationValue?.id;
    const normalized = text.trim();
    const key = this.idempotencyKey().trim();
    if (!conversationId) {
      throw new Error("A mobile conversation must be open before sending text.");
    }
    if (!normalized) {
      throw new Error("Typed message text is required.");
    }
    if (!key || key.length > 200) {
      throw new Error("A bounded typed-message idempotency key is required.");
    }

    const response = await this.backend.addTypedMessage(
      conversationId,
      {
        clientRequestId: key,
        text: normalized,
        replyMode: "text",
        realtimeSessionId: null
      },
      key);

    // Persistence is the acceptance boundary; provider interruption follows it.
    this.voiceSession?.interrupt();
    this.voiceSession?.sendEvent({
      type: "conversation.item.create",
      item: {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: normalized }]
      }
    });
    this.voiceSession?.sendEvent(createTextOnlyResponseEvent());
    return response;
  }
}
