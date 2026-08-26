export type MobileFeedEntity = {
  id: string;
  status: string;
  entityVersion?: number | string;
  [key: string]: unknown;
};

export type MobileSignalREvent = {
  eventId: string;
  type: string;
  payload: unknown;
};

export interface MobileFeedBackend {
  listTasks: (query?: { cursor?: string; limit?: number }) => Promise<{
    items: MobileFeedEntity[];
    nextCursor?: string | null;
  }>;
  listUnreadNotifications: () => Promise<MobileFeedEntity[]>;
  listPendingApprovals: () => Promise<MobileFeedEntity[]>;
  updateNotification?: (notificationId: string, action: "delivered" | "read" | "dismiss", idempotencyKey: string) => Promise<MobileFeedEntity>;
  decideApproval?: (approvalId: string, decision: "approve" | "deny", scope: "once" | "taskSession", idempotencyKey: string) => Promise<MobileFeedEntity>;
}

const nonTerminalStatuses = new Set([
  "queued",
  "assigned",
  "running",
  "waitingForApproval",
  "waitingForUserInput",
  "recovering",
  "cancellationRequested"
]);

export class MobileTaskNotificationFeed {
  private readonly taskById = new Map<string, MobileFeedEntity>();
  private readonly notificationById = new Map<string, MobileFeedEntity>();
  private readonly approvalById = new Map<string, MobileFeedEntity>();
  private readonly eventIds = new Set<string>();
  private readonly subscribers = new Set<() => void>();

  public constructor(private readonly backend: MobileFeedBackend) {}

  public get tasks(): readonly MobileFeedEntity[] {
    return [...this.taskById.values()].filter(item => nonTerminalStatuses.has(item.status));
  }

  public get notifications(): readonly MobileFeedEntity[] {
    return [...this.notificationById.values()];
  }

  public get approvals(): readonly MobileFeedEntity[] {
    return [...this.approvalById.values()].filter(item => item.status === "pending");
  }

  public subscribe(listener: () => void): () => void {
    this.subscribers.add(listener);
    return () => this.subscribers.delete(listener);
  }

  public async refresh(): Promise<void> {
    const [tasks, notifications, approvals] = await Promise.all([
      this.listAllTasks(),
      this.backend.listUnreadNotifications(),
      this.backend.listPendingApprovals()
    ]);
    this.taskById.clear();
    for (const task of tasks) {
      if (nonTerminalStatuses.has(task.status)) {
        this.taskById.set(task.id, task);
      }
    }
    for (const notification of notifications) {
      this.upsert(this.notificationById, notification);
    }
    this.approvalById.clear();
    for (const approval of approvals) {
      this.approvalById.set(approval.id, approval);
    }
    this.notify();
  }

  public clear(): void {
    this.taskById.clear();
    this.notificationById.clear();
    this.approvalById.clear();
    this.eventIds.clear();
    this.notify();
  }

  public acceptEvent(event: MobileSignalREvent): boolean {
    if (!event.eventId || this.eventIds.has(event.eventId)) {
      return false;
    }
    const payload = asEntity(event.payload);
    if (!payload) {
      return false;
    }
    const entity = normalizeEntity(payload);
    const target = event.type.startsWith("task.")
      ? this.taskById
      : event.type.startsWith("approval.")
        ? this.approvalById
        : event.type.startsWith("notification.")
          ? this.notificationById
          : undefined;
    if (!target) {
      return false;
    }
    this.eventIds.add(event.eventId);
    trimSet(this.eventIds);
    const changed = this.upsert(target, entity);
    if (changed) {
      this.notify();
    }
    return changed;
  }

  public async markNotification(
    notificationId: string,
    action: "delivered" | "read" | "dismiss",
    idempotencyKey: string
  ): Promise<MobileFeedEntity> {
    if (!this.backend.updateNotification) {
      throw new Error("Notification actions are not configured.");
    }
    const updated = await this.backend.updateNotification(notificationId, action, idempotencyKey);
    this.upsert(this.notificationById, updated);
    this.notify();
    return updated;
  }

  public async decideApproval(
    approvalId: string,
    decision: "approve" | "deny",
    scope: "once" | "taskSession",
    idempotencyKey: string
  ): Promise<MobileFeedEntity> {
    if (!this.backend.decideApproval) {
      throw new Error("Approval actions are not configured.");
    }
    const updated = await this.backend.decideApproval(approvalId, decision, scope, idempotencyKey);
    this.upsert(this.approvalById, updated);
    this.notify();
    return updated;
  }

  private upsert(target: Map<string, MobileFeedEntity>, item: MobileFeedEntity): boolean {
    const previous = target.get(item.id);
    if (previous && versionOf(item) <= versionOf(previous)) {
      return false;
    }
    target.set(item.id, item);
    return true;
  }

  private async listAllTasks(): Promise<MobileFeedEntity[]> {
    const items: MobileFeedEntity[] = [];
    const seenCursors = new Set<string>();
    let cursor: string | undefined;
    for (let pageNumber = 0; pageNumber < 1_000; pageNumber++) {
      const page = await this.backend.listTasks({ limit: 100, ...(cursor ? { cursor } : {}) });
      items.push(...page.items);
      const nextCursor = page.nextCursor ?? undefined;
      if (!nextCursor) {
        return items;
      }
      if (seenCursors.has(nextCursor)) {
        throw new Error("Task pagination returned a repeated cursor.");
      }
      seenCursors.add(nextCursor);
      cursor = nextCursor;
    }
    throw new Error("Task pagination exceeded the safety limit.");
  }

  private notify(): void {
    for (const subscriber of this.subscribers) {
      subscriber();
    }
  }
}

function normalizeEntity(value: Record<string, unknown>): MobileFeedEntity {
  const id = value.id ?? value.taskId ?? value.notificationId ?? value.approvalId;
  if (typeof id !== "string" || !id || typeof value.status !== "string") {
    throw new Error("Invalid mobile feed event payload.");
  }
  return { ...value, id, status: value.status } as MobileFeedEntity;
}

function asEntity(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function versionOf(value: MobileFeedEntity): number {
  const version = typeof value.entityVersion === "number"
    ? value.entityVersion
    : Number(value.entityVersion ?? 0);
  return Number.isFinite(version) ? version : 0;
}

function trimSet(values: Set<string>, max = 2_000): void {
  while (values.size > max) {
    const first = values.values().next().value as string | undefined;
    if (!first) {
      return;
    }
    values.delete(first);
  }
}
