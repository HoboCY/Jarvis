import { contextBridge, ipcRenderer } from "electron";

const jarvisApi = {
  getAppVersion: (): Promise<string> => ipcRenderer.invoke("app:getVersion") as Promise<string>
};

contextBridge.exposeInMainWorld("jarvis", jarvisApi);
