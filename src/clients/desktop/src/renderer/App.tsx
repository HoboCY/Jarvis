import { useEffect, useRef, useState } from "react";
import { decodeSignalREventEnvelope } from "@jarvis/contracts-ts";
import { ensureConversation } from "./conversation-flow.js";
import {
  DesktopRealtimeController,
  mapRealtimeCancelResponse,
  mapRealtimeTaskStatusResponse,
  type DesktopRealtimeStatus
} from "./realtime.js";
import {
  DesktopTaskNotificationFeed,
  ensureActiveDesktopTaskNotificationFeed,
  refreshFeedIfCurrent,
  refreshOnBackendConnectionState,
  type DesktopNotification,
  type DesktopTask
} from "./task-feed.js";
import {
  DesktopApprovalFeed,
  type DesktopApproval
} from "./approval-feed.js";

type Message = {
  id: string;
  role: string;
  text: string | null;
  status: string;
  inputModality?: string | null;
  outputModality?: string | null;
};

type Conversation = {
  id: string;
  title: string;
  messages: Message[];
  messageCount: number;
};

type ClientSecret = {
  realtimeSessionId: string;
  clientSecret: string;
  model: string;
  voice: string;
  instructions: string;
};

type Device = { deviceId: string; name: string; platform: string };

function taskFrom(value: unknown): DesktopTask {
  const item = asRecord(value);
  return {
    ...item,
    id: String(item.id),
    status: String(item.status),
    goal: typeof item.goal === "string" ? item.goal : undefined,
    progressSummary: typeof item.progressSummary === "string" ? item.progressSummary : null,
    resultSummary: typeof item.resultSummary === "string" ? item.resultSummary : null
  };
}

function notificationFrom(value: unknown): DesktopNotification {
  const item = asRecord(value);
  return {
    ...item,
    id: String(item.id),
    status: String(item.status),
    title: String(item.title),
    body: String(item.body)
  };
}

function approvalFrom(value: unknown): DesktopApproval {
  const item = asRecord(value);
  const kind = String(item.kind);
  const status = String(item.status);
  if (!["command", "fileWrite", "permission", "externalWrite"].includes(kind)
    || !["pending", "approved", "denied", "expired", "cancelled"].includes(status)) {
    throw new Error("Backend returned an invalid approval.");
  }
  return {
    id: String(item.id),
    taskId: String(item.taskId),
    executionId: item.executionId === null || item.executionId === undefined ? null : String(item.executionId),
    deviceId: String(item.deviceId),
    kind: kind as DesktopApproval["kind"],
    reason: String(item.reason),
    status: status as DesktopApproval["status"],
    scope: item.scope === "once" || item.scope === "taskSession" ? item.scope : null,
    expiresAtMs: typeof item.expiresAtMs === "number" ? item.expiresAtMs : null
  };
}

function listItems(value: unknown): unknown[] {
  const item = asRecord(value);
  return Array.isArray(item.items) ? item.items : [];
}

function createTaskFeed(): DesktopTaskNotificationFeed {
  return new DesktopTaskNotificationFeed({
    getTasks: async (conversationId, cursor, status) => {
      const page = asRecord(await window.jarvis.getTasks({ conversationId, cursor, status }));
      const nextCursor = page.nextCursor;
      if (nextCursor !== undefined && nextCursor !== null && typeof nextCursor !== "string") {
        throw new Error("Backend returned an invalid task cursor.");
      }
      return {
        items: listItems(page).map(taskFrom),
        nextCursor: typeof nextCursor === "string" ? nextCursor : null
      };
    },
    getUnreadNotifications: async () =>
      listItems(await window.jarvis.getNotifications()).map(notificationFrom),
    markDelivered: (notificationId, idempotencyKey) => window.jarvis.markNotificationDelivered({
      notificationId,
      idempotencyKey
    }),
    markRead: (notificationId, idempotencyKey) => window.jarvis.markNotificationRead({
      notificationId,
      idempotencyKey
    }),
    dismiss: (notificationId, idempotencyKey) => window.jarvis.dismissNotification({
      notificationId,
      idempotencyKey
    })
  });
}

function createApprovalFeed(): DesktopApprovalFeed {
  return new DesktopApprovalFeed({
    getPendingApprovals: async () =>
      listItems(await window.jarvis.getApprovals()).map(approvalFrom),
    decideApproval: async input => approvalFrom(await window.jarvis.decideApproval(input))
  });
}

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Backend returned an invalid response.");
  }
  return value as Record<string, unknown>;
}

function conversationFrom(value: unknown): Conversation {
  const item = asRecord(value);
  return {
    id: String(item.id),
    title: String(item.title),
    messages: Array.isArray(item.messages) ? item.messages.map(messageFrom) : [],
    messageCount: Number(item.messageCount ?? 0)
  };
}

function messageFrom(value: unknown): Message {
  const item = asRecord(value);
  return {
    id: String(item.id),
    role: String(item.role),
    text: typeof item.text === "string" ? item.text : null,
    status: String(item.status),
    inputModality: typeof item.inputModality === "string" ? item.inputModality : null,
    outputModality: typeof item.outputModality === "string" ? item.outputModality : null
  };
}

function clientSecretFrom(value: unknown): ClientSecret {
  const item = asRecord(value);
  if (typeof item.clientSecret !== "string"
    || typeof item.realtimeSessionId !== "string"
    || typeof item.instructions !== "string"
    || !item.instructions.trim()) {
    throw new Error("Backend returned an invalid ephemeral realtime secret.");
  }
  return {
    realtimeSessionId: item.realtimeSessionId,
    clientSecret: item.clientSecret,
    model: String(item.model),
    voice: String(item.voice),
    instructions: item.instructions
  };
}

function deviceFrom(value: unknown): Device {
  const item = asRecord(value);
  return { deviceId: String(item.deviceId), name: String(item.name), platform: String(item.platform) };
}

export function App() {
  const [version, setVersion] = useState("loading");
  const [conversation, setConversation] = useState<Conversation | undefined>();
  const [device, setDevice] = useState<Device | undefined>();
  const [status, setStatus] = useState<DesktopRealtimeStatus>("disconnected");
  const [error, setError] = useState<string | undefined>();
  const [draft, setDraft] = useState("");
  const [muted, setMuted] = useState(false);
  const [conversationIdInput, setConversationIdInput] = useState("");
  const [tasks, setTasks] = useState<readonly DesktopTask[]>([]);
  const [notifications, setNotifications] = useState<readonly DesktopNotification[]>([]);
  const [approvals, setApprovals] = useState<readonly DesktopApproval[]>([]);
  const [resolvingApprovalId, setResolvingApprovalId] = useState<string | undefined>();
  const [backendConnectionState, setBackendConnectionState] = useState("connecting");
  const controller = useRef<DesktopRealtimeController | undefined>(undefined);
  const feed = useRef<DesktopTaskNotificationFeed | undefined>(undefined);
  const approvalFeed = useRef<DesktopApprovalFeed | undefined>(undefined);
  const activeConversationId = useRef<string | undefined>(undefined);
  activeConversationId.current = conversation?.id;

  feed.current = ensureActiveDesktopTaskNotificationFeed(feed.current, createTaskFeed);
  approvalFeed.current ??= createApprovalFeed();

  async function refreshFeed(conversationId?: string): Promise<void> {
    const currentFeed = feed.current;
    if (!currentFeed) {
      return;
    }

    await refreshFeedIfCurrent(
      currentFeed,
      () => feed.current,
      (nextTasks, nextNotifications) => {
        setTasks(nextTasks);
        setNotifications(nextNotifications);
      },
      conversationId);
  }

  async function refreshApprovals(): Promise<void> {
    const current = approvalFeed.current;
    if (!current) {
      return;
    }
    await current.refresh();
    if (approvalFeed.current === current) {
      setApprovals(current.approvals);
    }
  }

  useEffect(() => {
    feed.current = ensureActiveDesktopTaskNotificationFeed(feed.current, createTaskFeed);
    let effectActive = true;
    void window.jarvis.getAppVersion().then(setVersion);
    void window.jarvis.getDesktopDevice()
      .then(value => setDevice(deviceFrom(value)))
      .catch(reason => setError(reason instanceof Error ? reason.message : "Desktop bootstrap failed."));

    const removeEventListener = window.jarvis.onBackendEvent(value => {
      try {
        const currentFeed = feed.current;
        if (!currentFeed) {
          return;
        }

        const decoded = decodeSignalREventEnvelope(value);
        void Promise.all([
          currentFeed.applyEvent(decoded),
          approvalFeed.current?.applyEvent({ eventId: decoded.eventId, type: decoded.type })
        ])
          .then(() => {
            if (!effectActive) {
              return;
            }
            setTasks(currentFeed.tasks);
            setNotifications(currentFeed.notifications);
            setApprovals(approvalFeed.current?.approvals ?? []);
          })
          .catch(reason => {
            if (effectActive) {
              setError(reason instanceof Error ? reason.message : "Task feed refresh failed.");
            }
          });
      } catch (reason) {
        if (effectActive) {
          setError(reason instanceof Error ? reason.message : "Invalid backend event.");
        }
      }
    });
    const removeConnectionListener = window.jarvis.onBackendConnectionState(value => {
      const state = asRecord(value).state;
      setBackendConnectionState(typeof state === "string" ? state : "disconnected");
      void refreshOnBackendConnectionState(state, refreshFeed, activeConversationId.current).catch(reason => {
        if (effectActive) {
          setError(reason instanceof Error ? reason.message : "Task feed refresh failed.");
        }
      });
      if (state === "connected") {
        void refreshApprovals().catch(reason => {
          if (effectActive) {
            setError(reason instanceof Error ? reason.message : "Approval refresh failed.");
          }
        });
      }
    });
    return () => {
      effectActive = false;
      removeEventListener();
      removeConnectionListener();
      feed.current?.dispose();
      approvalFeed.current?.dispose();
    };
  }, []);

  useEffect(() => {
    void refreshFeed(conversation?.id).catch(reason =>
      setError(reason instanceof Error ? reason.message : "Task feed refresh failed."));
    void refreshApprovals().catch(reason =>
      setError(reason instanceof Error ? reason.message : "Approval refresh failed."));
  }, [conversation?.id]);

  useEffect(() => () => {
    void controller.current?.disconnect("desktop-closed");
  }, []);

  async function createConversation(): Promise<Conversation | undefined> {
    setError(undefined);
    try {
      const value = await window.jarvis.createConversation({
        title: "Desktop Realtime",
        idempotencyKey: crypto.randomUUID()
      });
      const next = conversationFrom(value);
      setConversation(next);
      setConversationIdInput(next.id);
      return next;
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Conversation creation failed.");
      return undefined;
    }
  }

  async function loadConversation(): Promise<void> {
    setError(undefined);
    try {
      const value = await window.jarvis.getConversation(conversationIdInput.trim());
      setConversation(conversationFrom(value));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Conversation load failed.");
    }
  }

  async function connect(): Promise<void> {
    setError(undefined);
    try {
      const activeConversation = await ensureConversation(conversation, createConversation);
      if (!activeConversation) {
        return;
      }
      const activeDevice = device ?? deviceFrom(await window.jarvis.getDesktopDevice());
      setDevice(activeDevice);
      if (controller.current) {
        if (!await controller.current.disconnect("reconnect")) {
          setError("旧 Realtime Session 的消息尚未保存，请先重试保存。");
          return;
        }
        controller.current = undefined;
      }
      const secret = clientSecretFrom(await window.jarvis.createRealtimeClientSecret({
        conversationId: activeConversation.id,
        deviceId: activeDevice.deviceId,
        preferredVoice: null,
        idempotencyKey: crypto.randomUUID()
      }));
      const voice = secret.voice;
      const nextController = new DesktopRealtimeController(
        activeConversation.id,
        {
          markConnected: input => window.jarvis.realtimeConnected(input),
          markEnded: input => window.jarvis.realtimeEnded(input),
          ingest: async input => {
            const result = await window.jarvis.ingestRealtimeEvents(input);
            const refreshed = await window.jarvis.getConversation(activeConversation.id);
            setConversation(conversationFrom(refreshed));
            return result;
          },
          delegateTask: async (input, idempotencyKey) => {
            const result = await window.jarvis.delegateTask({
              ...input,
              conversationId: activeConversation.id,
              idempotencyKey
            });
            await refreshFeed(activeConversation.id);
            return result;
          },
          getTaskStatus: async input => mapRealtimeTaskStatusResponse(
            await window.jarvis.getTaskStatus(input.taskId)),
          cancelTask: async (input, idempotencyKey) => mapRealtimeCancelResponse(
            await window.jarvis.cancelTask({
              taskId: input.taskId,
              idempotencyKey
            }))
        },
        (nextStatus, nextError) => {
          setStatus(nextStatus);
          if (nextError) {
            setError(nextError);
          }
        }
      );
      nextController.setRotationProvider(async () => clientSecretFrom(await window.jarvis.createRealtimeClientSecret({
        conversationId: activeConversation.id,
        deviceId: activeDevice.deviceId,
        preferredVoice: voice,
        idempotencyKey: crypto.randomUUID()
      })));
      controller.current = nextController;
      await nextController.connect(secret);
    } catch (reason) {
      setStatus("degraded");
      setError(reason instanceof Error ? reason.message : "Realtime connection failed.");
    }
  }

  async function disconnect(): Promise<void> {
    const activeController = controller.current;
    if (!activeController) {
      return;
    }

    try {
      if (await activeController.disconnect()) {
        controller.current = undefined;
      } else {
        setError("消息尚未保存，Realtime Session 仍可重试。");
      }
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Realtime disconnect failed.");
    }
  }

  async function retryPersistence(): Promise<void> {
    const activeController = controller.current;
    if (!activeController) {
      return;
    }

    try {
      if (await activeController.retryPersistence()) {
        setError(undefined);
        if (activeController.status === "disconnected") {
          controller.current = undefined;
        }
      } else {
        setError("消息仍未保存，请稍后重试。");
      }
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Message persistence retry failed.");
    }
  }

  async function sendTyped(): Promise<void> {
    const text = draft.trim();
    if (!text || !conversation) {
      return;
    }
    setDraft("");

    const persistTyped = async (persistedText: string): Promise<void> => {
      await window.jarvis.addTypedMessage({
        conversationId: conversation.id,
        clientRequestId: crypto.randomUUID(),
        text: persistedText,
        realtimeSessionId: status === "connected" ? controller.current?.realtimeSessionId : undefined,
        idempotencyKey: crypto.randomUUID()
      });
      const refreshed = await window.jarvis.getConversation(conversation.id);
      setConversation(conversationFrom(refreshed));
    };

    try {
      if (status === "connected" && controller.current) {
        await controller.current.sendTyped(text, persistTyped);
      } else {
        // A provider/network failure leaves the conversation usable through the
        // durable text endpoint until Realtime can be connected again.
        await persistTyped(text);
      }
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Typed message failed.");
    }
  }

  async function resolveApproval(approvalId: string, decision: "approve" | "deny"): Promise<void> {
    const current = approvalFeed.current;
    if (!current || resolvingApprovalId) {
      return;
    }
    setResolvingApprovalId(approvalId);
    setError(undefined);
    try {
      if (decision === "approve") {
        await current.approveOnce(approvalId);
      } else {
        await current.deny(approvalId);
      }
      setApprovals(current.approvals);
      await refreshFeed(conversation?.id);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Approval decision failed.");
    } finally {
      setResolvingApprovalId(undefined);
    }
  }

  const popupNotification = notifications[0];

  return (
    <main>
      <h1>Jarvis</h1>
      <p>Desktop voice and typed input share one persisted Conversation.</p>
      <p aria-live="polite">状态：{status}{device ? ` · ${device.name}` : ""}</p>
      <div>
        <button type="button" onClick={() => void createConversation()}>新建会话</button>
        <input
          aria-label="Conversation ID"
          value={conversationIdInput}
          onChange={event => setConversationIdInput(event.target.value)}
          placeholder="Conversation ID"
        />
        <button type="button" onClick={() => void loadConversation()}>加载会话</button>
      </div>
      <div>
        <button type="button" onClick={() => void connect()} disabled={status === "connecting" || status === "connected"}>
          连接 Realtime
        </button>
        <button type="button" onClick={() => void disconnect()} disabled={status === "disconnected"}>
          断开
        </button>
        {status === "degraded" && controller.current ? (
          <button type="button" onClick={() => void retryPersistence()}>
            重试保存
          </button>
        ) : null}
        <button
          type="button"
          onClick={() => {
            controller.current?.setMicrophoneMuted(!muted);
            setMuted(value => !value);
          }}
          disabled={status !== "connected"}
        >
          {muted ? "打开麦克风" : "关闭麦克风"}
        </button>
        <button type="button" onClick={() => controller.current?.interrupt()} disabled={status !== "connected"}>
          停止助手回答
        </button>
      </div>
      <form onSubmit={event => { event.preventDefault(); void sendTyped(); }}>
        <input
          aria-label="Typed message"
          value={draft}
          onChange={event => setDraft(event.target.value)}
          placeholder="输入文字，发送到当前 Realtime Session"
        />
        <button type="submit" disabled={!conversation || status === "connecting" || !draft.trim()}>发送文字</button>
      </form>
      {error ? <p role="alert">{error}</p> : null}
      {popupNotification ? (
        <aside role="dialog" aria-label="Notification popup" aria-live="polite">
          <h2>{popupNotification.title}</h2>
          <p>{popupNotification.body}</p>
          <button
            type="button"
            onClick={() => void feed.current?.read(popupNotification.id).then(() => {
              setNotifications(feed.current?.notifications ?? []);
            }).catch(reason => setError(reason instanceof Error ? reason.message : "Notification read failed."))}
          >
            已读并关闭
          </button>
          <button
            type="button"
            onClick={() => void feed.current?.dismiss(popupNotification.id).then(() => {
              setNotifications(feed.current?.notifications ?? []);
            }).catch(reason => setError(reason instanceof Error ? reason.message : "Notification dismiss failed."))}
          >
            忽略并关闭
          </button>
        </aside>
      ) : null}
      {conversation ? (
        <section aria-label="Conversation messages">
          <h2>{conversation.title}</h2>
          <p>{conversation.id} · {conversation.messageCount} 条消息</p>
          <ol>
            {conversation.messages.map(message => (
              <li key={message.id}>
                <strong>{message.role}</strong> <small>{message.status}</small>
                <p>{message.text ?? "（无文字内容）"}</p>
              </li>
            ))}
          </ol>
        </section>
      ) : <p>尚未选择 Conversation。</p>}
      <section aria-label="Approval Requests">
        <h2>待审批 ({approvals.length})</h2>
        {approvals.length > 0 ? (
          <ul>
            {approvals.map(approval => (
              <li key={approval.id}>
                <strong>{approval.kind}</strong>
                <p>{approval.reason}</p>
                <p><small>Task {approval.taskId} · Device {approval.deviceId}</small></p>
                <button
                  type="button"
                  disabled={resolvingApprovalId !== undefined}
                  onClick={() => void resolveApproval(approval.id, "approve")}
                >
                  仅批准本次
                </button>
                <button
                  type="button"
                  disabled={resolvingApprovalId !== undefined}
                  onClick={() => void resolveApproval(approval.id, "deny")}
                >
                  拒绝并停止
                </button>
              </li>
            ))}
          </ul>
        ) : <p>当前没有待审批操作。</p>}
      </section>
      <section aria-label="Task Center">
        <h2>Task Center</h2>
        <p>Control Plane：{backendConnectionState} · {tasks.length} 个任务</p>
        {tasks.length > 0 ? (
          <ul>
            {tasks.map(task => (
              <li key={task.id}>
                <strong>{task.status}</strong> {task.goal ?? task.id}
                {task.resultSummary ? <p>{task.resultSummary}</p> : null}
                {task.status !== "succeeded"
                  && task.status !== "failed"
                  && task.status !== "cancelled" ? (
                    <button
                      type="button"
                      onClick={() => void window.jarvis.cancelTask({
                        taskId: task.id,
                        idempotencyKey: crypto.randomUUID()
                      }).then(() => refreshFeed(conversation?.id)).catch(reason =>
                        setError(reason instanceof Error ? reason.message : "Task cancellation failed."))}
                    >
                      取消任务
                    </button>
                  ) : null}
              </li>
            ))}
          </ul>
        ) : <p>当前没有非终态任务。</p>}
      </section>
      <section aria-label="Notifications">
        <h2>通知 ({notifications.length})</h2>
        {notifications.length > 0 ? (
          <ul>
            {notifications.map(notification => (
              <li key={notification.id}>
                <strong>{notification.title}</strong>
                <p>{notification.body}</p>
                <button
                  type="button"
                  onClick={() => void feed.current?.read(notification.id).then(() => {
                    setNotifications(feed.current?.notifications ?? []);
                  }).catch(reason => setError(reason instanceof Error ? reason.message : "Notification read failed."))}
                >
                  已读
                </button>
                <button
                  type="button"
                  onClick={() => void feed.current?.dismiss(notification.id).then(() => {
                    setNotifications(feed.current?.notifications ?? []);
                  }).catch(reason => setError(reason instanceof Error ? reason.message : "Notification dismiss failed."))}
                >
                  忽略
                </button>
              </li>
            ))}
          </ul>
        ) : <p>没有未读通知。</p>}
      </section>
      <small>Desktop version: {version}</small>
    </main>
  );
}
