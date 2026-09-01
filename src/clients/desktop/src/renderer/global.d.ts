interface Window {
  jarvis: {
    getAppVersion: () => Promise<string>;
    getDiagnostics: () => Promise<unknown>;
    getDesktopDevice: () => Promise<unknown>;
    createMobilePairing: (input: {
      deviceName: string;
      platform: string;
      capabilities?: string[];
      idempotencyKey: string;
    }) => Promise<unknown>;
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
      capabilityEnvelope: {
        readFiles: boolean;
        writeFiles: boolean;
        runCommands: boolean;
        network: boolean;
        allowedRoots: string[];
      } | null;
      idempotencyKey: string;
    }) => Promise<unknown>;
    getTaskStatus: (taskId: string) => Promise<unknown>;
    submitTaskUserInput: (input: {
      taskId: string;
      requestId: string;
      executionId?: string;
      requestIdIsString?: boolean;
      answers: Record<string, { answers: string[] }>;
      idempotencyKey: string;
    }) => Promise<{
      taskId: string;
      executionId: string;
      requestId: string;
      accepted: boolean;
      status: "queued" | "assigned" | "running" | "waitingForApproval" | "waitingForUserInput" | "recovering" | "cancellationRequested" | "succeeded" | "failed" | "cancelled";
      executionStatus: "assigned" | "running" | "waitingForApproval" | "recovering" | "succeeded" | "failed" | "cancelled" | "waitingForUserInput";
    }>;
    cancelTask: (input: { taskId: string; idempotencyKey: string }) => Promise<unknown>;
    rememberFact: (input: {
      key: string;
      value: string;
      sourceMessageId: string;
      sensitive: boolean;
      idempotencyKey: string;
    }) => Promise<unknown>;
    getTasks: (input?: {
      conversationId?: string;
      cursor?: string;
      status?: "queued" | "assigned" | "running" | "waitingForApproval" | "waitingForUserInput" | "recovering" | "cancellationRequested";
    }) => Promise<unknown>;
    getNotifications: (conversationId?: string) => Promise<unknown>;
    markNotificationDelivered: (input: { notificationId: string; idempotencyKey: string }) => Promise<unknown>;
    markNotificationRead: (input: { notificationId: string; idempotencyKey: string }) => Promise<unknown>;
    dismissNotification: (input: { notificationId: string; idempotencyKey: string }) => Promise<unknown>;
    applyNotificationAction: (input: { notificationId: string; actionId: "acknowledge"; idempotencyKey: string }) => Promise<unknown>;
    getApprovals: () => Promise<unknown>;
    getBackendConnectionState: () => Promise<unknown>;
    decideApproval: (input: {
      approvalId: string;
      decision: "approve" | "deny";
      scope: "once" | "taskSession";
      clientRequestId: string;
      idempotencyKey: string;
    }) => Promise<unknown>;
    onBackendEvent: (listener: (event: unknown) => void) => () => void;
    onBackendConnectionState: (listener: (event: unknown) => void) => () => void;
  };
}
