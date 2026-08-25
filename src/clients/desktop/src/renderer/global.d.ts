interface Window {
  jarvis: {
    getAppVersion: () => Promise<string>;
    getDesktopDevice: () => Promise<unknown>;
    createConversation: (input: { title?: string | null; idempotencyKey: string }) => Promise<unknown>;
    getConversation: (conversationId: string) => Promise<unknown>;
    addTypedMessage: (input: {
      conversationId: string;
      clientRequestId: string;
      text: string;
      realtimeSessionId?: string;
      idempotencyKey: string;
    }) => Promise<unknown>;
    createRealtimeClientSecret: (input: {
      conversationId: string;
      deviceId: string;
      preferredVoice?: string | null;
      idempotencyKey: string;
    }) => Promise<unknown>;
    realtimeConnected: (input: {
      sessionId: string;
      externalSessionId: string;
      idempotencyKey: string;
    }) => Promise<unknown>;
    realtimeEnded: (input: {
      sessionId: string;
      reason: string;
      status: "rotated" | "disconnected" | "failed";
      idempotencyKey: string;
    }) => Promise<unknown>;
    ingestRealtimeEvents: (input: {
      conversationId: string;
      events: unknown[];
      idempotencyKey: string;
    }) => Promise<unknown>;
  };
}
