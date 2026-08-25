import { app, BrowserWindow, ipcMain, shell } from "electron";
import {
  getRendererEntryUrl,
  isAllowedExternalUrl,
  isAllowedNavigation,
  secureWebPreferences
} from "./security.js";

function createMainWindow(rendererEntryUrl: string): BrowserWindow {
  const window = new BrowserWindow({
    width: 1280,
    height: 900,
    webPreferences: {
      ...secureWebPreferences,
      preload: new URL("../preload/index.js", import.meta.url).pathname
    }
  });

  window.webContents.on("will-navigate", (event, url) => {
    if (isAllowedNavigation(url, rendererEntryUrl)) {
      return;
    }

    event.preventDefault();
    if (isAllowedExternalUrl(url)) {
      void shell.openExternal(url);
    }
  });

  window.webContents.setWindowOpenHandler(({ url }) => {
    if (isAllowedExternalUrl(url)) {
      void shell.openExternal(url);
    }
    return { action: "deny" };
  });

  void window.loadURL(rendererEntryUrl);
  return window;
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.whenReady().then(() => {
    ipcMain.handle("app:getVersion", () => app.getVersion());
    const rendererEntryUrl = getRendererEntryUrl(app.isPackaged, process.env.JARVIS_DEV_SERVER_URL);
    createMainWindow(rendererEntryUrl);
  });
}
