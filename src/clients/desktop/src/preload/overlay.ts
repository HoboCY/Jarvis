import { contextBridge, ipcRenderer } from "electron";

type SafeNotificationProjection = {
  id: string;
  title: string;
  body: string;
};

const overlayApi = {
  onNotification: (listener: (notification: SafeNotificationProjection) => void): (() => void) => {
    const handler = (_event: Electron.IpcRendererEvent, value: unknown): void => {
      if (typeof value !== "object" || value === null || Array.isArray(value)) {
        return;
      }
      const item = value as Record<string, unknown>;
      if (typeof item.id !== "string" || typeof item.title !== "string" || typeof item.body !== "string") {
        return;
      }
      listener({ id: item.id, title: item.title, body: item.body });
    };
    ipcRenderer.on("overlay:notification", handler);
    return () => ipcRenderer.removeListener("overlay:notification", handler);
  }
};

contextBridge.exposeInMainWorld("jarvisOverlay", overlayApi);
