import { contextBridge, ipcRenderer } from "electron";
import { mapWakeWordErrorCode } from "../wake-word-error.js";
import { normalizeDesktopActionFailure, unwrapDesktopIpcResult } from "../renderer/desktop-ipc.js";

function invoke<T>(channel: string, ...args: unknown[]): Promise<T> {
  return ipcRenderer.invoke(channel, ...args)
    .then(value => unwrapDesktopIpcResult<T>(value))
    .catch(reason => {
      throw normalizeDesktopActionFailure(reason);
    });
}

const jarvisApi = {
  getAppVersion: (): Promise<string> => invoke("app:getVersion"),
  getDiagnostics: (): Promise<unknown> => invoke("backend:getDiagnostics"),
  getDesktopDevice: (): Promise<unknown> => invoke("backend:getDesktopDevice"),
  createMobilePairing: (input: {
    deviceName: string;
    platform: string;
    capabilities?: string[];
    idempotencyKey: string;
  }): Promise<unknown> => invoke("backend:createMobilePairing", input),
  createConversation: (input: { title?: string | null; idempotencyKey: string }): Promise<unknown> =>
    invoke("backend:createConversation", input),
  getConversation: (conversationId: string): Promise<unknown> =>
    invoke("backend:getConversation", { conversationId }),
  addTypedMessage: (input: {
    conversationId: string;
    clientRequestId: string;
    text: string;
    realtimeSessionId?: string;
    idempotencyKey: string;
  }): Promise<unknown> => invoke("backend:addTypedMessage", input),
  createRealtimeClientSecret: (input: {
    conversationId: string;
    deviceId: string;
    preferredVoice?: string | null;
    idempotencyKey: string;
  }): Promise<unknown> => invoke("backend:createRealtimeClientSecret", input),
  realtimeConnected: (input: {
    sessionId: string;
    externalSessionId: string;
    idempotencyKey: string;
  }): Promise<unknown> => invoke("backend:realtimeConnected", input),
  realtimeEnded: (input: {
    sessionId: string;
    reason: string;
    status: "rotated" | "disconnected" | "failed";
    idempotencyKey: string;
  }): Promise<unknown> => invoke("backend:realtimeEnded", input),
  ingestRealtimeEvents: (input: {
    conversationId: string;
    events: unknown[];
    idempotencyKey: string;
  }): Promise<unknown> => invoke("backend:ingestRealtimeEvents", input),
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
  }): Promise<unknown> => invoke("backend:delegateTask", input),
  getTaskStatus: (taskId: string): Promise<unknown> =>
    invoke("backend:getTaskStatus", { taskId }),
  submitTaskUserInput: (input: {
    taskId: string;
    requestId: string;
    executionId?: string;
    requestIdIsString?: boolean;
    answers: Record<string, { answers: string[] }>;
    idempotencyKey: string;
  }): Promise<{
    taskId: string;
    executionId: string;
    requestId: string;
    accepted: boolean;
    status: "queued" | "assigned" | "running" | "waitingForApproval" | "waitingForUserInput" | "recovering" | "cancellationRequested" | "succeeded" | "failed" | "cancelled";
    executionStatus: "assigned" | "running" | "waitingForApproval" | "recovering" | "succeeded" | "failed" | "cancelled" | "waitingForUserInput";
  }> => invoke("backend:submitTaskUserInput", input),
  cancelTask: (input: { taskId: string; idempotencyKey: string }): Promise<unknown> =>
    invoke("backend:cancelTask", input),
  rememberFact: (input: {
    key: string;
    value: string;
    sourceMessageId: string;
    sensitive: boolean;
    idempotencyKey: string;
  }): Promise<unknown> => invoke("backend:rememberFact", input),
  getTasks: (input?: {
    conversationId?: string;
    cursor?: string;
    status?: "queued" | "assigned" | "running" | "waitingForApproval" | "waitingForUserInput" | "recovering" | "cancellationRequested";
  }): Promise<unknown> =>
    invoke("backend:getTasks", input ?? {}),
  getNotifications: (conversationId?: string): Promise<unknown> =>
    invoke("backend:getNotifications", { conversationId }),
  markNotificationDelivered: (input: { notificationId: string; idempotencyKey: string }): Promise<unknown> =>
    invoke("backend:deliveredNotification", input),
  markNotificationRead: (input: { notificationId: string; idempotencyKey: string }): Promise<unknown> =>
    invoke("backend:readNotification", input),
  dismissNotification: (input: { notificationId: string; idempotencyKey: string }): Promise<unknown> =>
    invoke("backend:dismissNotification", input),
  applyNotificationAction: (input: { notificationId: string; actionId: "acknowledge"; idempotencyKey: string }): Promise<unknown> =>
    invoke("backend:applyNotificationAction", input),
  getApprovals: (): Promise<unknown> =>
    invoke("backend:getApprovals"),
  getBackendConnectionState: (): Promise<unknown> =>
    invoke("backend:getConnectionState"),
  decideApproval: (input: {
    approvalId: string;
    decision: "approve" | "deny";
    scope: "once" | "taskSession";
    clientRequestId: string;
    idempotencyKey: string;
  }): Promise<unknown> => invoke("backend:decideApproval", input),
  startWakeWordDetection: (keyword: string): Promise<void> =>
    invoke("wake-word:start", { keyword }),
  stopWakeWordDetection: (): Promise<void> =>
    invoke("wake-word:stop"),
  onWakeWordDetected: (listener: () => void): (() => void) => {
    const handler = (): void => listener();
    ipcRenderer.on("wake-word:detected", handler);
    return () => ipcRenderer.removeListener("wake-word:detected", handler);
  },
  onWakeWordError: (listener: (message: string) => void): (() => void) => {
    const handler = (_event: Electron.IpcRendererEvent, value: unknown): void => {
      listener(mapWakeWordErrorCode(value));
    };
    ipcRenderer.on("wake-word:error", handler);
    return () => ipcRenderer.removeListener("wake-word:error", handler);
  },
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
