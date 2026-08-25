import {
  RealtimeAgent,
  RealtimeSession,
  type RealtimeSessionOptions,
  type RealtimeTransportLayer,
  tool
} from "@openai/agents/realtime";
import { z } from "zod";

export const realtimeToolNames = ["delegate_task", "get_task_status", "cancel_task", "remember_fact"] as const;

export type RealtimeToolName = (typeof realtimeToolNames)[number];

export type NormalizedRealtimeEvent = {
  version: 1;
  eventId: string;
  externalItemId?: string;
  realtimeSessionId: string;
  role: "user" | "assistant";
  modality: "voice" | "typedText" | "audio" | "audioWithTranscript" | "text";
  status: "partial" | "streaming" | "completed" | "interrupted" | "failed";
  text?: string;
  occurredAtMs?: number;
};

const normalizedRealtimeEventSchema = z.object({
  version: z.literal(1),
  eventId: z.string().min(1).max(200),
  externalItemId: z.string().min(1).max(200).optional(),
  realtimeSessionId: z.string().uuid(),
  role: z.enum(["user", "assistant"]),
  modality: z.enum(["voice", "typedText", "audio", "audioWithTranscript", "text"]),
  status: z.enum(["partial", "streaming", "completed", "interrupted", "failed"]),
  text: z.string().max(100_000).optional(),
  occurredAtMs: z.number().int().nonnegative().optional()
});

export function parseNormalizedRealtimeEvent(value: unknown): NormalizedRealtimeEvent {
  return normalizedRealtimeEventSchema.parse(value);
}

export function createTextOnlyResponseEvent(): {
  type: "response.create";
  response: { output_modalities: ["text"] };
} {
  return {
    type: "response.create",
    response: { output_modalities: ["text"] }
  };
}

const taskIdInput = z.object({ taskId: z.string().uuid() });
const delegateTaskInput = z.object({
  goal: z.string().min(1),
  expectedOutput: z.string().nullable(),
  requiredCapabilities: z.array(z.string()),
  preferredDeviceId: z.string().uuid().nullable(),
  sourceMessageIds: z.array(z.string().uuid()),
  attachmentRefs: z.array(z.string())
});
const rememberFactInput = z.object({ fact: z.string().min(1) });

export type RealtimeToolResult = {
  available: false;
  code: "phase3-unavailable";
  tool: RealtimeToolName;
};

function unavailable(toolName: RealtimeToolName): string {
  const result: RealtimeToolResult = {
    available: false,
    code: "phase3-unavailable",
    tool: toolName
  };
  return JSON.stringify(result);
}

export const realtimeTools = [
  tool({
    name: "delegate_task",
    description: "Queue backend work. Phase 2 has no task execution and returns unavailable.",
    parameters: delegateTaskInput,
    execute: async () => unavailable("delegate_task")
  }),
  tool({
    name: "get_task_status",
    description: "Read a backend task status. Phase 2 has no task execution and returns unavailable.",
    parameters: taskIdInput,
    execute: async () => unavailable("get_task_status")
  }),
  tool({
    name: "cancel_task",
    description: "Cancel backend work. Phase 2 has no task execution and returns unavailable.",
    parameters: taskIdInput,
    execute: async () => unavailable("cancel_task")
  }),
  tool({
    name: "remember_fact",
    description: "Store a durable fact. Phase 2 memory storage is unavailable.",
    parameters: rememberFactInput,
    execute: async () => unavailable("remember_fact")
  })
] as const;

export function createRealtimeAgent(instructions: string, voice?: string): RealtimeAgent {
  const normalizedInstructions = instructions.trim();
  if (!normalizedInstructions) {
    throw new Error("Realtime instructions are required.");
  }

  return new RealtimeAgent({
    name: "jarvis-realtime",
    instructions: normalizedInstructions,
    voice,
    tools: [...realtimeTools]
  });
}

export type TypedMessagePersistence = (text: string) => Promise<unknown>;

export async function sendTypedMessage(
  session: Pick<RealtimeSession, "interrupt" | "transport">,
  text: string,
  persist: TypedMessagePersistence
): Promise<void> {
  const normalized = text.trim();
  if (!normalized) {
    throw new Error("Typed message text is required.");
  }

  // The backend write is the acceptance boundary. Only after it succeeds may audio be interrupted.
  await persist(normalized);
  session.interrupt();
  session.transport.sendEvent({
    type: "conversation.item.create",
    item: {
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: normalized }]
    }
  });
  session.transport.sendEvent(createTextOnlyResponseEvent());
}

export type RealtimeConnectionErrorCode = "unauthorized" | "network" | "provider" | "unknown";

export function mapRealtimeConnectionError(error: unknown): {
  code: RealtimeConnectionErrorCode;
  message: string;
} {
  const message = error instanceof Error ? error.message : String(error);
  const normalized = message.toLowerCase();
  if (normalized.includes("401") || normalized.includes("unauthorized") || normalized.includes("token")) {
    return { code: "unauthorized", message: "Realtime authentication failed." };
  }

  if (normalized.includes("network") || normalized.includes("websocket") || normalized.includes("webrtc")) {
    return { code: "network", message: "Realtime connection is unavailable." };
  }

  if (normalized.includes("429") || normalized.includes("500") || normalized.includes("provider")) {
    return { code: "provider", message: "Realtime provider is temporarily unavailable." };
  }

  return { code: "unknown", message: "Realtime connection failed." };
}

export type RotationState = "disconnected" | "active" | "rotation-ready";

export class SessionRotationStateMachine {
  private readonly rotationAfterMs: number;
  private connectedAtMs: number | undefined;
  private lastActivityAtMs: number | undefined;
  private userSpeaking = false;
  private assistantSpeaking = false;
  private rotationReady = false;

  public constructor(rotationAfterMs = 50 * 60 * 1000) {
    this.rotationAfterMs = rotationAfterMs;
  }

  public get state(): RotationState {
    if (this.connectedAtMs === undefined) {
      return "disconnected";
    }

    return this.rotationReady ? "rotation-ready" : "active";
  }

  public connected(nowMs: number): void {
    this.connectedAtMs = nowMs;
    this.lastActivityAtMs = nowMs;
    this.rotationReady = false;
  }

  public disconnected(): void {
    this.connectedAtMs = undefined;
    this.lastActivityAtMs = undefined;
    this.rotationReady = false;
    this.userSpeaking = false;
    this.assistantSpeaking = false;
  }

  public setUserSpeaking(active: boolean, nowMs: number): void {
    this.userSpeaking = active;
    this.activity(nowMs);
  }

  public setAssistantSpeaking(active: boolean, nowMs: number): void {
    this.assistantSpeaking = active;
    this.activity(nowMs);
  }

  public activity(nowMs: number): void {
    this.lastActivityAtMs = nowMs;
  }

  public tick(nowMs: number): RotationState {
    if (this.connectedAtMs === undefined) {
      return "disconnected";
    }

    if (nowMs - this.connectedAtMs < this.rotationAfterMs) {
      return this.state;
    }

    this.rotationReady = true;
    return this.state;
  }

  public canRotate(): boolean {
    return this.rotationReady && !this.userSpeaking && !this.assistantSpeaking;
  }

  public consumeRotation(): boolean {
    if (!this.canRotate()) {
      return false;
    }

    this.rotationReady = false;
    return true;
  }
}

export type RealtimeSessionFactory = (
  agent: RealtimeAgent,
  options: { transport: RealtimeTransportLayer; model: string }
) => RealtimeSession;

export { RealtimeAgent, RealtimeSession, type RealtimeSessionOptions };
