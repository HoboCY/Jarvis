import { app, BrowserWindow, ipcMain, shell } from "electron";
import { randomUUID } from "node:crypto";
import {
  getRendererEntryUrl,
  isAllowedExternalUrl,
  isAllowedNavigation,
  secureWebPreferences
} from "./security.js";

type JsonRecord = Record<string, unknown>;

const backendBaseUrl = process.env.JARVIS_API_BASE_URL ?? "http://127.0.0.1:5000";
const backendBearer = process.env.JARVIS_LOCAL_BEARER;

async function requestBackend(
  path: string,
  method: "GET" | "POST",
  body?: unknown,
  idempotencyKey?: string
): Promise<unknown> {
  if (!backendBearer || backendBearer.length < 32) {
    throw new Error("The Desktop backend bearer is not configured in the Electron main process.");
  }

  const headers = new Headers({ Authorization: `Bearer ${backendBearer}` });
  if (body !== undefined) {
    headers.set("Content-Type", "application/json");
  }
  if (method === "POST") {
    if (!idempotencyKey || idempotencyKey.length > 200) {
      throw new Error("A bounded Idempotency-Key is required for Desktop writes.");
    }
    headers.set("Idempotency-Key", idempotencyKey);
  }

  const response = await fetch(new URL(path, backendBaseUrl), {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  if (!response.ok) {
    throw new Error(`Jarvis backend request failed with ${response.status}.`);
  }

  return response.json();
}

function record(value: unknown): JsonRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Invalid Desktop IPC request.");
  }
  return value as JsonRecord;
}

function requiredString(value: unknown, name: string, maxLength = 200): string {
  if (typeof value !== "string" || value.trim().length === 0 || value.length > maxLength) {
    throw new Error(`Invalid ${name}.`);
  }
  return value.trim();
}

function requiredBody(value: unknown): JsonRecord {
  return record(value);
}

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
    ipcMain.handle("backend:getDesktopDevice", () =>
      requestBackend("/api/v1/realtime/desktop-device", "POST", {}, randomUUID()));
    ipcMain.handle("backend:createConversation", (_event, value: unknown) => {
      const input = requiredBody(value);
      return requestBackend(
        "/api/v1/conversations",
        "POST",
        { title: typeof input.title === "string" ? input.title.slice(0, 500) : null },
        requiredString(input.idempotencyKey, "idempotencyKey"));
    });
    ipcMain.handle("backend:getConversation", (_event, value: unknown) => {
      const input = requiredBody(value);
      return requestBackend(
        `/api/v1/conversations/${encodeURIComponent(requiredString(input.conversationId, "conversationId"))}`,
        "GET");
    });
    ipcMain.handle("backend:addTypedMessage", (_event, value: unknown) => {
      const input = requiredBody(value);
      return requestBackend(
        `/api/v1/conversations/${encodeURIComponent(requiredString(input.conversationId, "conversationId"))}/messages/typed`,
        "POST",
        {
          clientRequestId: requiredString(input.clientRequestId, "clientRequestId"),
          text: requiredString(input.text, "text", 100_000),
          replyMode: "text",
          realtimeSessionId: typeof input.realtimeSessionId === "string"
            ? requiredString(input.realtimeSessionId, "realtimeSessionId")
            : null
        },
        requiredString(input.idempotencyKey, "idempotencyKey"));
    });
    ipcMain.handle("backend:createRealtimeClientSecret", (_event, value: unknown) => {
      const input = requiredBody(value);
      return requestBackend(
        "/api/v1/realtime/client-secrets",
        "POST",
        {
          conversationId: requiredString(input.conversationId, "conversationId"),
          deviceId: requiredString(input.deviceId, "deviceId"),
          preferredVoice: typeof input.preferredVoice === "string" ? input.preferredVoice.slice(0, 100) : null
        },
        requiredString(input.idempotencyKey, "idempotencyKey"));
    });
    ipcMain.handle("backend:realtimeConnected", (_event, value: unknown) => {
      const input = requiredBody(value);
      return requestBackend(
        `/api/v1/realtime/sessions/${encodeURIComponent(requiredString(input.sessionId, "sessionId"))}/connected`,
        "POST",
        { externalSessionId: requiredString(input.externalSessionId, "externalSessionId") },
        requiredString(input.idempotencyKey, "idempotencyKey"));
    });
    ipcMain.handle("backend:realtimeEnded", (_event, value: unknown) => {
      const input = requiredBody(value);
      const status = input.status;
      if (status !== "rotated" && status !== "disconnected" && status !== "failed") {
        throw new Error("Invalid realtime session end status.");
      }
      return requestBackend(
        `/api/v1/realtime/sessions/${encodeURIComponent(requiredString(input.sessionId, "sessionId"))}/ended`,
        "POST",
        { reason: requiredString(input.reason, "reason", 500), status },
        requiredString(input.idempotencyKey, "idempotencyKey"));
    });
    ipcMain.handle("backend:ingestRealtimeEvents", (_event, value: unknown) => {
      const input = requiredBody(value);
      if (!Array.isArray(input.events) || input.events.length < 1 || input.events.length > 100) {
        throw new Error("Invalid realtime event batch.");
      }
      return requestBackend(
        `/api/v1/conversations/${encodeURIComponent(requiredString(input.conversationId, "conversationId"))}/realtime-events:ingest`,
        "POST",
        { version: 1, events: input.events },
        requiredString(input.idempotencyKey, "idempotencyKey"));
    });
    const rendererEntryUrl = getRendererEntryUrl(app.isPackaged, process.env.JARVIS_DEV_SERVER_URL);
    createMainWindow(rendererEntryUrl);
  });
}
