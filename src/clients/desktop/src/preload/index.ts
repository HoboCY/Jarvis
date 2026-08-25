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
  }): Promise<unknown> => ipcRenderer.invoke("backend:ingestRealtimeEvents", input) as Promise<unknown>
};

contextBridge.exposeInMainWorld("jarvis", jarvisApi);
