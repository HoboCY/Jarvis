export interface SignalREventEnvelope<TPayload = unknown> {
  eventId: string;
  occurredAt: number;
  type: string;
  payload: TPayload;
}

export interface ConversationCreatedPayload {
  userId: string;
  conversationId: string;
  title: string;
}

export interface TypedMessageCreatedPayload {
  userId: string;
  conversationId: string;
  messageId: string;
  sequence: number;
}

export interface TaskUpdatedPayload {
  userId: string;
  conversationId: string;
  taskId: string;
  status: string;
  eventType: string;
  occurredAt: number;
  entityVersion: number;
}

export interface NotificationCreatedPayload {
  userId: string;
  notificationId: string;
  taskId?: string | null;
  conversationId?: string | null;
  type: string;
  severity: string;
  title: string;
  body: string;
  status: "pending" | "delivered";
  dedupKey: string;
  entityVersion: number;
}

export interface NotificationUpdatedPayload extends Omit<NotificationCreatedPayload, "status"> {
  status: "pending" | "delivered" | "read" | "actioned" | "dismissed";
  action: "delivered" | "read" | "dismiss";
}

export function decodeSignalREventEnvelope(
  value: unknown,
): SignalREventEnvelope {
  if (!isRecord(value)
    || typeof value.eventId !== "string"
    || value.eventId.length === 0
    || typeof value.occurredAt !== "number"
    || !Number.isFinite(value.occurredAt)
    || typeof value.type !== "string"
    || value.type.length === 0
    || !("payload" in value)) {
    throw new TypeError("Invalid SignalR event envelope.");
  }

  return {
    eventId: value.eventId,
    occurredAt: value.occurredAt,
    type: value.type,
    payload: value.payload,
  };
}

export function decodeSignalREventEnvelopeJson(
  json: string,
): SignalREventEnvelope {
  return decodeSignalREventEnvelope(JSON.parse(json) as unknown);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
