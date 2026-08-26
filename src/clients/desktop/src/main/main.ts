import { HubConnectionBuilder, type HubConnection } from "@microsoft/signalr";
import { app, BrowserWindow, ipcMain, shell } from "electron";
import { randomUUID } from "node:crypto";
import {
  getRendererEntryUrl,
  isAllowedExternalUrl,
  isAllowedNavigation,
  secureWebPreferences
} from "./security.js";
import { isUuid } from "./input-validation.js";

type JsonRecord = Record<string, unknown>;

const backendBaseUrl = process.env.JARVIS_API_BASE_URL ?? "http://127.0.0.1:5000";
const backendBearer = process.env.JARVIS_LOCAL_BEARER;
const clientHubPath = "/hubs/client";
const taskApiPath = "/api/v1/tasks";
const notificationApiPath = "/api/v1/notifications";
const approvalApiPath = "/api/v1/approvals";
const nonTerminalTaskStatuses = new Set([
  "queued",
  "assigned",
  "running",
  "waitingForApproval",
  "waitingForUserInput",
  "recovering",
  "cancellationRequested"
]);

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

function isSignalREnvelope(value: unknown): value is JsonRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }

  const envelope = value as JsonRecord;
  return typeof envelope.eventId === "string"
    && envelope.eventId.length > 0
    && envelope.eventId.length <= 200
    && typeof envelope.occurredAt === "number"
    && Number.isFinite(envelope.occurredAt)
    && typeof envelope.type === "string"
    && envelope.type.length > 0
    && typeof envelope.payload === "object"
    && envelope.payload !== null
    && !Array.isArray(envelope.payload);
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

function optionalString(value: unknown, name: string, maxLength = 200): string | undefined {
  if (value === undefined || value === null || value === "") {
    return undefined;
  }

  return requiredString(value, name, maxLength);
}

function requiredStringArray(value: unknown, name: string, maxItems = 100): string[] {
  if (!Array.isArray(value) || value.length > maxItems) {
    throw new Error(`Invalid ${name}.`);
  }

  return value.map(item => requiredString(item, name));
}

function requiredUuidArray(value: unknown, name: string, maxItems = 100): string[] {
  return requiredStringArray(value, name, maxItems).map(item => {
    if (!isUuid(item)) {
      throw new Error(`Invalid ${name}.`);
    }
    return item;
  });
}

function optionalCapabilityEnvelope(value: unknown): JsonRecord | null {
  if (value === null || value === undefined) {
    return null;
  }

  const envelope = requiredBody(value);
  for (const name of ["readFiles", "writeFiles", "runCommands", "network"] as const) {
    if (typeof envelope[name] !== "boolean") {
      throw new Error(`Invalid capabilityEnvelope.${name}.`);
    }
  }
  if (!Array.isArray(envelope.allowedRoots) || envelope.allowedRoots.length > 20) {
    throw new Error("Invalid capabilityEnvelope.allowedRoots.");
  }

  return {
    readFiles: envelope.readFiles,
    writeFiles: envelope.writeFiles,
    runCommands: envelope.runCommands,
    network: envelope.network,
    allowedRoots: envelope.allowedRoots.map(root =>
      requiredString(root, "capabilityEnvelope.allowedRoots", 4_000))
  };
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

function startSignalR(window: BrowserWindow): HubConnection | undefined {
  if (!backendBearer || backendBearer.length < 32) {
    return undefined;
  }

  const connection = new HubConnectionBuilder()
    .withUrl(new URL(clientHubPath, backendBaseUrl).toString(), {
      accessTokenFactory: () => backendBearer
    })
    .withAutomaticReconnect()
    .build();

  const sendConnectionState = (state: "connected" | "reconnecting" | "disconnected", error?: Error): void => {
    if (!window.isDestroyed()) {
      window.webContents.send("backend:connectionState", {
        state,
        error: error?.message
      });
    }
  };

  for (const eventType of [
    "task.updated",
    "task.eventAdded",
    "notification.created",
    "notification.updated",
    "approval.required",
    "approval.resolved"
  ]) {
    connection.on(eventType, envelope => {
      if (!isSignalREnvelope(envelope)) {
        return;
      }
      if (!window.isDestroyed()) {
        window.webContents.send("backend:event", envelope);
      }
    });
  }

  connection.onreconnecting(error => sendConnectionState("reconnecting", error));
  connection.onreconnected(() => sendConnectionState("connected"));
  connection.onclose(error => sendConnectionState("disconnected", error));
  void connection.start()
    .then(() => sendConnectionState("connected"))
    .catch(error => sendConnectionState("disconnected", error instanceof Error ? error : undefined));
  return connection;
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
    ipcMain.handle("backend:delegateTask", (_event, value: unknown) => {
      const input = requiredBody(value);
      const requiredCapabilities = requiredStringArray(input.requiredCapabilities, "requiredCapabilities", 20);
      const sourceMessageIds = requiredUuidArray(input.sourceMessageIds, "sourceMessageIds");
      const preferredDeviceId = input.preferredDeviceId === null || input.preferredDeviceId === undefined
        ? null
        : requiredString(input.preferredDeviceId, "preferredDeviceId");
      const expectedOutput = input.expectedOutput === null || input.expectedOutput === undefined
        ? null
        : requiredString(input.expectedOutput, "expectedOutput", 100_000);
      return requestBackend(
        taskApiPath,
        "POST",
        {
          conversationId: requiredString(input.conversationId, "conversationId"),
          goal: requiredString(input.goal, "goal", 100_000),
          expectedOutput,
          requiredCapabilities,
          preferredDeviceId,
          sourceMessageIds,
          attachmentRefs: requiredStringArray(input.attachmentRefs, "attachmentRefs", 100),
          capabilityEnvelope: optionalCapabilityEnvelope(input.capabilityEnvelope)
        },
        requiredString(input.idempotencyKey, "idempotencyKey"));
    });
    ipcMain.handle("backend:getTaskStatus", (_event, value: unknown) => {
      const input = requiredBody(value);
      return requestBackend(
        `${taskApiPath}/${encodeURIComponent(requiredString(input.taskId, "taskId"))}`,
        "GET");
    });
    ipcMain.handle("backend:cancelTask", (_event, value: unknown) => {
      const input = requiredBody(value);
      return requestBackend(
        `${taskApiPath}/${encodeURIComponent(requiredString(input.taskId, "taskId"))}/cancel`,
        "POST",
        {},
        requiredString(input.idempotencyKey, "idempotencyKey"));
    });
    ipcMain.handle("backend:getTasks", (_event, value: unknown) => {
      const input = requiredBody(value);
      const conversationId = optionalString(input.conversationId, "conversationId");
      const cursor = optionalString(input.cursor, "cursor");
      const status = optionalString(input.status, "status");
      if (status && !nonTerminalTaskStatuses.has(status)) {
        throw new Error("Invalid task status filter.");
      }
      const query = new URLSearchParams({ limit: "100" });
      if (conversationId) {
        query.set("conversationId", conversationId);
      }
      if (cursor) {
        query.set("cursor", cursor);
      }
      if (status) {
        query.set("status", status);
      }
      const suffix = query.toString();
      return requestBackend(`${taskApiPath}${suffix ? `?${suffix}` : ""}`, "GET");
    });
    ipcMain.handle("backend:getNotifications", (_event, value: unknown) => {
      const input = requiredBody(value);
      const conversationId = optionalString(input.conversationId, "conversationId");
      const query = new URLSearchParams({ status: "unread" });
      if (conversationId) {
        query.set("conversationId", conversationId);
      }
      return requestBackend(`${notificationApiPath}?${query.toString()}`, "GET");
    });
    for (const action of ["delivered", "read", "dismiss"] as const) {
      ipcMain.handle(`backend:${action}Notification`, (_event, value: unknown) => {
        const input = requiredBody(value);
        return requestBackend(
          `${notificationApiPath}/${encodeURIComponent(requiredString(input.notificationId, "notificationId"))}/${action}`,
          "POST",
          {},
          requiredString(input.idempotencyKey, "idempotencyKey"));
      });
    }
    ipcMain.handle("backend:getApprovals", () =>
      requestBackend(`${approvalApiPath}?status=pending`, "GET"));
    ipcMain.handle("backend:decideApproval", (_event, value: unknown) => {
      const input = requiredBody(value);
      const approvalId = requiredString(input.approvalId, "approvalId");
      if (!isUuid(approvalId)) {
        throw new Error("Invalid approvalId.");
      }
      const decision = input.decision;
      if (decision !== "approve" && decision !== "deny") {
        throw new Error("Invalid approval decision.");
      }
      const scope = input.scope;
      if (scope !== "once" && scope !== "taskSession") {
        throw new Error("Invalid approval scope.");
      }
      return requestBackend(
        `${approvalApiPath}/${encodeURIComponent(approvalId)}/decision`,
        "POST",
        {
          decision,
          scope,
          clientRequestId: requiredString(input.clientRequestId, "clientRequestId")
        },
        requiredString(input.idempotencyKey, "idempotencyKey"));
    });
    const rendererEntryUrl = getRendererEntryUrl(app.isPackaged, process.env.JARVIS_DEV_SERVER_URL);
    const window = createMainWindow(rendererEntryUrl);
    const signalRConnection = startSignalR(window);
    app.on("before-quit", () => {
      if (signalRConnection) {
        void signalRConnection.stop();
      }
    });
  });
}
