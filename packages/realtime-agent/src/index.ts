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

export type RealtimeTaskBackend = {
  delegateTask: (input: DelegateTaskInput, idempotencyKey: string) => Promise<unknown>;
  getTaskStatus: (input: TaskStatusInput, idempotencyKey: string) => Promise<unknown>;
  cancelTask: (input: TaskStatusInput, idempotencyKey: string) => Promise<unknown>;
};

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
const capabilityEnvelopeInput = z.object({
  readFiles: z.boolean(),
  writeFiles: z.boolean(),
  runCommands: z.boolean(),
  network: z.boolean(),
  allowedRoots: z.array(z.string().min(1).max(4_000)).max(20)
});
const delegateTaskInput = z.object({
  goal: z.string().min(1),
  expectedOutput: z.string().nullable(),
  requiredCapabilities: z.array(z.string()),
  preferredDeviceId: z.string().uuid().nullable(),
  sourceMessageIds: z.array(z.string().uuid()),
  attachmentRefs: z.array(z.string()),
  capabilityEnvelope: capabilityEnvelopeInput.nullable()
});
const rememberFactInput = z.object({
  key: z.string().min(1),
  value: z.string().min(1),
  sourceMessageId: z.string().uuid(),
  sensitive: z.boolean()
});

export type TaskStatusInput = z.infer<typeof taskIdInput>;
export type DelegateTaskInput = z.infer<typeof delegateTaskInput>;

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

export type RealtimeToolOptions = {
  backend?: RealtimeTaskBackend;
  sessionScope?: string;
};

export function createRealtimeToolIdempotencyKey(
  sessionScope: string,
  toolName: Exclude<RealtimeToolName, "remember_fact">,
  callId: string | undefined
): string {
  const scope = sessionScope.trim() || "realtime-session";
  const call = callId?.trim() || "missing-call-id";
  const key = `${scope}:${toolName}:${call}`;
  if (key.length <= 200) {
    return key;
  }

  // Keep a short readable scope/tool prefix, but hash the complete input so
  // long call ids that share a prefix cannot alias the backend idempotency key.
  return `${scope.slice(0, 64)}:${toolName}:${hashRealtimeKey(key)}`;
}

function hashRealtimeKey(value: string): string {
  let first = 2_166_136_261;
  let second = 2_246_822_519;
  let third = 3_266_480_991;
  let fourth = 668_265_263;
  for (const character of value) {
    const code = character.codePointAt(0)!;
    first = Math.imul(first ^ code, 16_777_619);
    second = Math.imul(second ^ (code + first), 2_654_435_761);
    third = Math.imul(third ^ (code + second), 2_246_822_519);
    fourth = Math.imul(fourth ^ (code + third), 3_266_480_991);
  }

  return [first, second, third, fourth]
    .map(valuePart => (valuePart >>> 0).toString(16).padStart(8, "0"))
    .join("");
}

function backendError(toolName: RealtimeToolName): string {
  return JSON.stringify({
    available: false,
    code: "backend-error",
    tool: toolName,
    message: "The authenticated backend could not complete this tool call."
  });
}

export function createRealtimeTools(options: RealtimeToolOptions = {}) {
  const backend = options.backend;
  const sessionScope = options.sessionScope ?? "realtime-session";
  const responseCache = new Map<string, string>();

  const executeBackend = async <TInput>(
    toolName: Exclude<RealtimeToolName, "remember_fact">,
    input: TInput,
    callId: string | undefined,
    execute: (idempotencyKey: string) => Promise<unknown>
  ): Promise<string> => {
    if (!backend) {
      return unavailable(toolName);
    }

    const idempotencyKey = createRealtimeToolIdempotencyKey(sessionScope, toolName, callId);
    const cached = responseCache.get(idempotencyKey);
    if (cached) {
      return cached;
    }

    try {
      const response = JSON.stringify(await execute(idempotencyKey)) ?? "null";
      responseCache.set(idempotencyKey, response);
      return response;
    } catch {
      return backendError(toolName);
    }
  };

  return [
    tool({
      name: "delegate_task",
      description: "Queue backend work and return the persisted task acceptance state.",
      parameters: delegateTaskInput,
      execute: async (input, _context, details) => executeBackend(
        "delegate_task",
        input,
        details?.toolCall?.callId,
        idempotencyKey => backend!.delegateTask(input, idempotencyKey))
    }),
    tool({
      name: "get_task_status",
      description: "Read the authenticated user's persisted backend task status.",
      parameters: taskIdInput,
      execute: async (input, _context, details) => executeBackend(
        "get_task_status",
        input,
        details?.toolCall?.callId,
        idempotencyKey => backend!.getTaskStatus(input, idempotencyKey))
    }),
    tool({
      name: "cancel_task",
      description: "Request cancellation of the authenticated user's backend task.",
      parameters: taskIdInput,
      execute: async (input, _context, details) => executeBackend(
        "cancel_task",
        input,
        details?.toolCall?.callId,
        idempotencyKey => backend!.cancelTask(input, idempotencyKey))
    }),
    tool({
      name: "remember_fact",
      description: "Store a durable fact. Phase 5 memory storage is unavailable.",
      parameters: rememberFactInput,
      execute: async () => unavailable("remember_fact")
    })
  ] as const;
}

export const realtimeTools = createRealtimeTools();

export function createRealtimeAgent(
  instructions: string,
  voice?: string,
  toolOptions: RealtimeToolOptions = {}
): RealtimeAgent {
  const normalizedInstructions = instructions.trim();
  if (!normalizedInstructions) {
    throw new Error("Realtime instructions are required.");
  }

  return new RealtimeAgent({
    name: "jarvis-realtime",
    instructions: normalizedInstructions,
    voice,
    tools: [...createRealtimeTools(toolOptions)]
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
