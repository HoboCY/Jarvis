import { contextBridge, ipcRenderer } from "electron";

const jarvisApi = {
  getAppVersion: (): Promise<string> => ipcRenderer.invoke("app:getVersion") as Promise<string>,
  getDesktopDevice: (): Promise<unknown> => ipcRenderer.invoke("backend:getDesktopDevice") as Promise<unknown>,
  createConversation: (input: { title?: string | null; idempotencyKey: string }): Promise<unknown> =>
    ipcRenderer.invoke("backend:createConversation", input) as Promise<unknown>,
  getConversation: (conversationId: string): Promise<unknown> =>
    ipcRenderer.invoke("backend:getConversation", { conversationId }) as Promise<unknown>,
  addTypedMessage: (input: {
    conversationId: string;
    clientRequestId: string;
    text: string;
    realtimeSessionId?: string;
    idempotencyKey: string;
  }): Promise<unknown> => ipcRenderer.invoke("backend:addTypedMessage", input) as Promise<unknown>,
  createRealtimeClientSecret: (input: {
    conversationId: string;
    deviceId: string;
    preferredVoice?: string | null;
    idempotencyKey: string;
  }): Promise<unknown> => ipcRenderer.invoke("backend:createRealtimeClientSecret", input) as Promise<unknown>,
  realtimeConnected: (input: {
    sessionId: string;
    externalSessionId: string;
    idempotencyKey: string;
  }): Promise<unknown> => ipcRenderer.invoke("backend:realtimeConnected", input) as Promise<unknown>,
  realtimeEnded: (input: {
    sessionId: string;
    reason: string;
    status: "rotated" | "disconnected" | "failed";
    idempotencyKey: string;
  }): Promise<unknown> => ipcRenderer.invoke("backend:realtimeEnded", input) as Promise<unknown>,
  ingestRealtimeEvents: (input: {
    conversationId: string;
    events: unknown[];
    idempotencyKey: string;
  }): Promise<unknown> => ipcRenderer.invoke("backend:ingestRealtimeEvents", input) as Promise<unknown>,
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
  }): Promise<unknown> => ipcRenderer.invoke("backend:delegateTask", input) as Promise<unknown>,
  getTaskStatus: (taskId: string): Promise<unknown> =>
    ipcRenderer.invoke("backend:getTaskStatus", { taskId }) as Promise<unknown>,
  cancelTask: (input: { taskId: string; idempotencyKey: string }): Promise<unknown> =>
    ipcRenderer.invoke("backend:cancelTask", input) as Promise<unknown>,
  getTasks: (input?: {
    conversationId?: string;
    cursor?: string;
    status?: "queued" | "assigned" | "running" | "waitingForApproval" | "waitingForUserInput" | "recovering" | "cancellationRequested";
  }): Promise<unknown> =>
    ipcRenderer.invoke("backend:getTasks", input ?? {}) as Promise<unknown>,
  getNotifications: (conversationId?: string): Promise<unknown> =>
    ipcRenderer.invoke("backend:getNotifications", { conversationId }) as Promise<unknown>,
  markNotificationDelivered: (input: { notificationId: string; idempotencyKey: string }): Promise<unknown> =>
    ipcRenderer.invoke("backend:deliveredNotification", input) as Promise<unknown>,
  markNotificationRead: (input: { notificationId: string; idempotencyKey: string }): Promise<unknown> =>
    ipcRenderer.invoke("backend:readNotification", input) as Promise<unknown>,
  dismissNotification: (input: { notificationId: string; idempotencyKey: string }): Promise<unknown> =>
    ipcRenderer.invoke("backend:dismissNotification", input) as Promise<unknown>,
  getApprovals: (): Promise<unknown> =>
    ipcRenderer.invoke("backend:getApprovals") as Promise<unknown>,
  decideApproval: (input: {
    approvalId: string;
    decision: "approve" | "deny";
    scope: "once" | "taskSession";
    clientRequestId: string;
    idempotencyKey: string;
  }): Promise<unknown> => ipcRenderer.invoke("backend:decideApproval", input) as Promise<unknown>,
  onBackendEvent: (listener: (event: unknown) => void): (() => void) => {
    const handler = (_event: Electron.IpcRendererEvent, value: unknown): void => listener(value);
    ipcRenderer.on("backend:event", handler);
    return () => ipcRenderer.removeListener("backend:event", handler);
  },
  onBackendConnectionState: (listener: (event: unknown) => void): (() => void) => {
    const handler = (_event: Electron.IpcRendererEvent, value: unknown): void => listener(value);
    ipcRenderer.on("backend:connectionState", handler);
    return () => ipcRenderer.removeListener("backend:connectionState", handler);
  }
};

contextBridge.exposeInMainWorld("jarvis", jarvisApi);
