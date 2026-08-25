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
    delegateTask: (input: {
      conversationId: string;
      goal: string;
      expectedOutput?: string | null;
      requiredCapabilities: string[];
      preferredDeviceId?: string | null;
      sourceMessageIds: string[];
      attachmentRefs: string[];
      idempotencyKey: string;
    }) => Promise<unknown>;
    getTaskStatus: (taskId: string) => Promise<unknown>;
    cancelTask: (input: { taskId: string; idempotencyKey: string }) => Promise<unknown>;
    getTasks: (input?: {
      conversationId?: string;
      cursor?: string;
      status?: "queued" | "assigned" | "running" | "waitingForApproval" | "waitingForUserInput" | "recovering" | "cancellationRequested";
    }) => Promise<unknown>;
    getNotifications: (conversationId?: string) => Promise<unknown>;
    markNotificationDelivered: (input: { notificationId: string; idempotencyKey: string }) => Promise<unknown>;
    markNotificationRead: (input: { notificationId: string; idempotencyKey: string }) => Promise<unknown>;
    dismissNotification: (input: { notificationId: string; idempotencyKey: string }) => Promise<unknown>;
    onBackendEvent: (listener: (event: unknown) => void) => () => void;
    onBackendConnectionState: (listener: (event: unknown) => void) => () => void;
  };
}
