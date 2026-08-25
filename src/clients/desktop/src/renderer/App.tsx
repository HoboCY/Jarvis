import { useEffect, useRef, useState } from "react";
import { ensureConversation } from "./conversation-flow.js";
import { DesktopRealtimeController, type DesktopRealtimeStatus } from "./realtime.js";

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
  const controller = useRef<DesktopRealtimeController | undefined>(undefined);

  useEffect(() => {
    void window.jarvis.getAppVersion().then(setVersion);
    void window.jarvis.getDesktopDevice()
      .then(value => setDevice(deviceFrom(value)))
      .catch(reason => setError(reason instanceof Error ? reason.message : "Desktop bootstrap failed."));
  }, []);

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
          }
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
      <small>Desktop version: {version}</small>
    </main>
  );
}
