export type DesktopTask = {
  id: string;
  status: string;
  goal?: string;
  executionId?: string;
  progressSummary?: string | null;
  resultSummary?: string | null;
  entityVersion?: number;
  pendingUserInput?: DesktopPendingUserInput;
  [key: string]: unknown;
};

export type DesktopPendingUserInputOption = {
  label: string;
  description: string;
};

export type DesktopPendingUserInputQuestion = {
  id: string;
  header: string;
  question: string;
  isOther: boolean;
  options: readonly DesktopPendingUserInputOption[] | null;
};

export type DesktopPendingUserInput = {
  requestId: string;
  requestIdIsString: boolean;
  itemId: string;
  threadId: string;
  turnId: string;
  questions: readonly DesktopPendingUserInputQuestion[];
  expiresAtMs: number | null;
};

export type DesktopNotification = {
  id: string;
  status: string;
  title: string;
  body: string;
  actions?: readonly NotificationActionId[];
  [key: string]: unknown;
};

export type NotificationActionId = "acknowledge";

export function notificationActionsFrom(value: unknown): readonly NotificationActionId[] {
  if (typeof value !== "string" || value.length > 200) {
    return [];
  }

  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed)
      && parsed.length === 1
      && parsed[0] === "acknowledge"
      ? ["acknowledge"]
      : [];
  } catch {
    return [];
  }
}

export type DesktopTaskPage = {
  items: readonly DesktopTask[];
  nextCursor: string | null;
};

export type DesktopTaskPageResult = DesktopTaskPage | readonly DesktopTask[];

export function pendingUserInputFrom(value: unknown): DesktopPendingUserInput | undefined {
  const item = record(value);
  if (!item
    || typeof item.requestId !== "string"
    || item.requestId.trim().length === 0
    || item.requestId.length > 200
    || item.requestIdIsString !== undefined && typeof item.requestIdIsString !== "boolean"
    || typeof item.itemId !== "string"
    || item.itemId.trim().length === 0
    || item.itemId.length > 500
    || typeof item.threadId !== "string"
    || item.threadId.trim().length === 0
    || item.threadId.length > 500
    || typeof item.turnId !== "string"
    || item.turnId.trim().length === 0
    || item.turnId.length > 500
    || item.status !== undefined && item.status !== "pending"
    || !Array.isArray(item.questions)
    || item.questions.length < 1
    || item.questions.length > 3) {
    return undefined;
  }

  const questions: DesktopPendingUserInputQuestion[] = [];
  const questionIds = new Set<string>();
  for (const questionValue of item.questions) {
    const question = record(questionValue);
    if (!question
      || typeof question.id !== "string"
      || question.id.trim().length === 0
      || question.id.length > 200
      || questionIds.has(question.id.trim())
      || typeof question.header !== "string"
      || question.header.trim().length === 0
      || question.header.length > 200
      || typeof question.question !== "string"
      || question.question.trim().length === 0
      || question.question.length > 4_000
      || question.isSecret === true
      || question.isSecret !== undefined && typeof question.isSecret !== "boolean"
      || question.isOther !== undefined && typeof question.isOther !== "boolean") {
      return undefined;
    }

    let options: DesktopPendingUserInputOption[] | null = null;
    if (question.options !== null && question.options !== undefined) {
      if (!Array.isArray(question.options) || question.options.length > 20) {
        return undefined;
      }
      const labels = new Set<string>();
      options = [];
      for (const optionValue of question.options) {
        const option = record(optionValue);
        if (!option
          || typeof option.label !== "string"
          || option.label.trim().length === 0
          || option.label.length > 200
          || typeof option.description !== "string"
          || option.description.trim().length === 0
          || option.description.length > 2_000
          || labels.has(option.label.trim())) {
          return undefined;
        }
        labels.add(option.label.trim());
        options.push({ label: option.label.trim(), description: option.description.trim() });
      }
    }

    const id = question.id.trim();
    questionIds.add(id);
    questions.push({
      id,
      header: question.header.trim(),
      question: question.question.trim(),
      isOther: question.isOther === true,
      options
    });
  }

  return {
    requestId: item.requestId.trim(),
    requestIdIsString: item.requestIdIsString !== false,
    itemId: item.itemId.trim(),
    threadId: item.threadId.trim(),
    turnId: item.turnId.trim(),
    questions,
    expiresAtMs: typeof item.expiresAtMs === "number" && Number.isFinite(item.expiresAtMs)
      ? item.expiresAtMs
      : null
  };
}

export function desktopTaskFrom(value: unknown): DesktopTask | undefined {
  const item = record(value);
  if (!item
    || typeof item.id !== "string"
    || item.id.trim().length === 0
    || item.id.length > 200
    || typeof item.status !== "string"
    || item.status.trim().length === 0
    || item.status.length > 64) {
    return undefined;
  }

  const pendingUserInput = item.status !== "waitingForUserInput"
    || item.pendingUserInput === null
    || item.pendingUserInput === undefined
    ? undefined
    : pendingUserInputFrom(item.pendingUserInput);
  const entityVersion = readEntityVersion(item);
  const execution = record(item.execution);
  const executionId = typeof execution?.id === "string" && execution.id.trim().length > 0 && execution.id.length <= 200
    ? execution.id.trim()
    : undefined;
  const task: DesktopTask = {
    id: item.id.trim(),
    status: item.status.trim(),
    ...(executionId === undefined ? {} : { executionId }),
    goal: typeof item.goal === "string" && item.goal.length <= 100_000 ? item.goal : undefined,
    progressSummary: item.progressSummary === null
      ? null
      : typeof item.progressSummary === "string" && item.progressSummary.length <= 2_000
        ? item.progressSummary
        : undefined,
    resultSummary: item.resultSummary === null
      ? null
      : typeof item.resultSummary === "string" && item.resultSummary.length <= 100_000
        ? item.resultSummary
        : undefined,
    ...(entityVersion === undefined ? {} : { entityVersion })
  };
  if (pendingUserInput) {
    task.pendingUserInput = pendingUserInput;
  }
  return task;
}

export const nonTerminalTaskStatuses = [
  "queued",
  "assigned",
  "running",
  "waitingForApproval",
  "waitingForUserInput",
  "recovering",
  "cancellationRequested"
] as const;
export type NonTerminalTaskStatus = typeof nonTerminalTaskStatuses[number];

export const maxTrackedFeedEntities = 256;
const authoritativeRefreshMaxAttempts = 2;
const authoritativeRefreshRetryDelayMs = 25;

export type DesktopTaskFeedRunAction = <T>(
  key: string,
  execute: (idempotencyKey: string) => Promise<T>
) => Promise<T>;

export type DesktopTaskFeedBackend = {
  getTasks: (
    conversationId?: string,
    cursor?: string,
    status?: NonTerminalTaskStatus
  ) => Promise<DesktopTaskPageResult>;
  getUnreadNotifications: () => Promise<readonly DesktopNotification[]>;
  markDelivered: (notificationId: string, idempotencyKey: string) => Promise<unknown>;
  markRead: (notificationId: string, idempotencyKey: string) => Promise<unknown>;
  dismiss: (notificationId: string, idempotencyKey: string) => Promise<unknown>;
  applyAction?: (notificationId: string, actionId: NotificationActionId, idempotencyKey: string) => Promise<unknown>;
  runAction?: DesktopTaskFeedRunAction;
};

export async function collectTaskPages(
  fetchPage: (cursor?: string) => Promise<DesktopTaskPageResult>,
  maxPages = Number.POSITIVE_INFINITY
): Promise<readonly DesktopTask[]> {
  const tasks: DesktopTask[] = [];
  const seenCursors = new Set<string>();
  let cursor: string | undefined;

  for (let page = 0; page < maxPages; page++) {
    const result = await fetchPage(cursor);
    const normalized = normalizeTaskPage(result);
    tasks.push(...normalized.items);
    if (!normalized.nextCursor) {
      return tasks;
    }

    if (seenCursors.has(normalized.nextCursor)) {
      throw new Error("Task pagination returned a repeated cursor.");
    }

    seenCursors.add(normalized.nextCursor);
    cursor = normalized.nextCursor;
  }

  throw new Error("Task pagination exceeded the maximum page count.");
}

export type DesktopFeedEvent = {
  eventId: string;
  occurredAt: number;
  type: string;
  payload: unknown;
};

type EventVersion = {
  occurredAt: number;
  entityVersion?: number;
  revision: number;
};

export async function refreshOnBackendConnectionState(
  state: unknown,
  refreshFeed: (conversationId?: string) => Promise<void>,
  conversationId?: string
): Promise<boolean> {
  if (state !== "connected") {
    return false;
  }

  await refreshFeed(conversationId);
  return true;
}

export async function refreshFeedIfCurrent(
  feed: DesktopTaskNotificationFeed,
  currentFeed: () => DesktopTaskNotificationFeed | undefined,
  applySnapshot: (
    tasks: readonly DesktopTask[],
    notifications: readonly DesktopNotification[]
  ) => void,
  conversationId?: string
): Promise<void> {
  await feed.refresh(conversationId);
  if (currentFeed() !== feed || feed.isDisposed) {
    return;
  }

  applySnapshot(feed.tasks, feed.notifications);
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export function notificationDeliveredIdempotencyKey(notificationId: string): string {
  return notificationActionIdempotencyKey(notificationId, "delivered");
}

export function notificationDeliveredActionKey(notificationId: string): string {
  return notificationActionIdempotencyKey(notificationId, "delivered");
}

export function notificationActionIdempotencyKey(
  notificationId: string,
  action: "delivered" | "read" | "dismiss" | NotificationActionId
): string {
  if (!notificationId) {
    throw new Error("NotificationId is required.");
  }

  const prefix = `notification-${action}:`;
  const directKey = `${prefix}${notificationId}`;
  if (directKey.length <= 200) {
    return directKey;
  }

  let hash = 2_166_136_261;
  for (const character of notificationId) {
    hash = Math.imul(hash ^ character.codePointAt(0)!, 16_777_619);
  }
  return `${prefix}${notificationId.slice(0, 160)}:${(hash >>> 0).toString(16)}`;
}

export class DesktopTaskNotificationFeed {
  private readonly taskById = new Map<string, DesktopTask>();
  private readonly notificationById = new Map<string, DesktopNotification>();
  private readonly deliveryInFlight = new Map<string, Promise<void>>();
  private readonly taskEventVersions = new Map<string, EventVersion>();
  private readonly notificationEventVersions = new Map<string, EventVersion>();
  private readonly notificationTombstones = new Map<string, EventVersion>();
  private taskWatermarkRequiresRefresh = false;
  private notificationWatermarkRequiresRefresh = false;
  private lastConversationId: string | undefined;
  private conversationGeneration = 0;
  private revision = 0;
  private refreshGeneration = 0;
  private appliedRefreshGeneration = 0;
  private authoritativeRefreshInFlight: {
    conversationId: string | undefined;
    conversationGeneration: number;
    promise: Promise<void>;
  } | undefined;
  private retryTimer: ReturnType<typeof setTimeout> | undefined;
  private retryWaiter: (() => void) | undefined;
  private disposed = false;

  public constructor(private readonly backend: DesktopTaskFeedBackend) {}

  public get tasks(): readonly DesktopTask[] {
    return [...this.taskById.values()];
  }

  public get notifications(): readonly DesktopNotification[] {
    return [...this.notificationById.values()];
  }

  public get currentNotification(): DesktopNotification | undefined {
    return this.notifications[0];
  }

  public get isDisposed(): boolean {
    return this.disposed;
  }

  public dispose(): void {
    this.disposed = true;
    this.conversationGeneration++;
    if (this.retryTimer !== undefined) {
      clearTimeout(this.retryTimer);
      this.retryTimer = undefined;
    }
    const retryWaiter = this.retryWaiter;
    this.retryWaiter = undefined;
    retryWaiter?.();
  }

  public async refresh(conversationId?: string): Promise<void> {
    if (this.disposed) {
      return;
    }

    if (conversationId !== this.lastConversationId) {
      this.conversationGeneration++;
    }
    this.lastConversationId = conversationId;
    const conversationGeneration = this.conversationGeneration;
    const refreshGeneration = ++this.refreshGeneration;
    const refreshRevision = this.revision;
    const [tasksByStatus, notifications] = await Promise.all([
      Promise.all(nonTerminalTaskStatuses.map(status =>
        collectTaskPages(cursor => this.backend.getTasks(conversationId, cursor, status)))),
      this.backend.getUnreadNotifications()
    ]);
    if (this.disposed || conversationGeneration !== this.conversationGeneration) {
      return;
    }
    const tasks = [...new Map(
      tasksByStatus.flat().filter(task => task.id).map(task => [task.id, task])
    ).values()];

    if (refreshGeneration < this.appliedRefreshGeneration) {
      return;
    }

    this.appliedRefreshGeneration = refreshGeneration;
    const taskOverlays = new Map(this.collectOverlays(this.taskById, this.taskEventVersions, refreshRevision));
    const notificationOverlays = new Map(this.collectOverlays(
      this.notificationById,
      this.notificationEventVersions,
      refreshRevision));
    const taskBaseline = new Map(this.taskById);
    const notificationBaseline = new Map(this.notificationById);
    const taskSnapshotVersions = new Map<string, EventVersion>();
    for (const task of tasks) {
      if (!task.id) {
        continue;
      }

      const snapshotVersion = this.snapshotVersion(task, refreshRevision);
      taskSnapshotVersions.set(task.id, snapshotVersion);
      this.seedSnapshot(this.taskEventVersions, task.id, snapshotVersion);
    }

    const notificationSnapshotVersions = new Map<string, EventVersion>();
    for (const notification of notifications) {
      if (!notification.id) {
        continue;
      }

      const snapshotVersion = this.snapshotVersion(notification, refreshRevision);
      const tombstone = this.notificationTombstones.get(notification.id);
      if (tombstone && compareEventVersion(snapshotVersion, tombstone) <= 0) {
        continue;
      }

      if (tombstone) {
        this.notificationTombstones.delete(notification.id);
      }

      notificationSnapshotVersions.set(notification.id, snapshotVersion);
      this.seedSnapshot(this.notificationEventVersions, notification.id, snapshotVersion);
    }
    this.trimTrackedVersions();

    this.taskById.clear();
    this.notificationById.clear();
    for (const task of tasks) {
      if (!task.id || !taskSnapshotVersions.has(task.id)) {
        continue;
      }

      const overlay = taskOverlays.get(task.id);
      const overlayVersion = overlay ? this.taskEventVersions.get(task.id) : undefined;
      const snapshotVersion = taskSnapshotVersions.get(task.id);
      if (overlay && overlayVersion && overlayVersion.revision > refreshRevision
        && (!snapshotVersion || compareEventVersion(overlayVersion, snapshotVersion) > 0)) {
        this.taskById.set(task.id, overlay);
      } else if (taskBaseline.has(task.id)
        && this.taskEventVersions.get(task.id) !== undefined
        && compareEventVersion(this.taskEventVersions.get(task.id)!, snapshotVersion!) > 0) {
        this.taskById.set(task.id, taskBaseline.get(task.id)!);
      } else {
        this.taskById.set(task.id, task);
      }
    }
    for (const [id, task] of taskOverlays) {
      if (!this.taskById.has(id)) {
        this.taskById.set(id, task);
      }
    }
    for (const notification of notifications) {
      if (notification.id && notificationSnapshotVersions.has(notification.id)) {
        const snapshotVersion = notificationSnapshotVersions.get(notification.id)!;
        const watermark = this.notificationEventVersions.get(notification.id);
        if (notificationBaseline.has(notification.id)
          && watermark !== undefined
          && compareEventVersion(watermark, snapshotVersion) > 0) {
          this.notificationById.set(notification.id, notificationBaseline.get(notification.id)!);
        } else {
          this.notificationById.set(notification.id, notification);
        }
      }
    }
    for (const [id, notification] of notificationOverlays) {
      const tombstone = this.notificationTombstones.get(id);
      const overlayVersion = this.notificationEventVersions.get(id);
      const snapshotVersion = notificationSnapshotVersions.get(id);
      if (!tombstone && overlayVersion && overlayVersion.revision > refreshRevision
        && (!snapshotVersion || compareEventVersion(overlayVersion, snapshotVersion) > 0)) {
        this.notificationById.set(id, notification);
      }
    }
    await Promise.all(
      [...this.notificationById.values()]
        .filter(notification => notification.status === "pending")
        .map(notification => this.markDeliveredIfPending(notification.id))
    );
  }

  public async applyEvent(event: DesktopFeedEvent): Promise<void> {
    const payload = record(event.payload);
    if (!payload) {
      return;
    }

    if (event.type === "task.updated" || event.type === "task.eventAdded") {
      const id = stringValue(payload.taskId) ?? stringValue(payload.id);
      if (!id) {
        return;
      }
      if (this.taskWatermarkRequiresRefresh && !this.taskEventVersions.has(id)) {
        await this.refreshAfterWatermarkFallback(this.lastConversationId);
        return;
      }
      const previous = this.taskById.get(id);
      const accepted = this.recordEvent(
        this.taskEventVersions,
        id,
        event.occurredAt,
        readEntityVersion(payload),
        previous?.status,
        stringValue(payload.status));
      if (!accepted) {
        return;
      }
      const status = stringValue(payload.status) ?? previous?.status ?? "queued";
      const nextTask = desktopTaskFrom({
        id,
        status,
        execution: payload.executionId === undefined && previous?.executionId === undefined
          ? undefined
          : { id: payload.executionId ?? previous?.executionId },
        goal: payload.goal ?? previous?.goal,
        progressSummary: payload.progressSummary ?? previous?.progressSummary,
        resultSummary: payload.resultSummary ?? previous?.resultSummary,
        entityVersion: readEntityVersion(payload) ?? previous?.entityVersion,
        pendingUserInput: Object.hasOwn(payload, "pendingUserInput")
          ? payload.pendingUserInput
          : previous?.pendingUserInput
      });
      if (nextTask) {
        this.taskById.set(id, nextTask);
      }
      return;
    }

    if (event.type !== "notification.created" && event.type !== "notification.updated") {
      return;
    }

    const id = stringValue(payload.notificationId) ?? stringValue(payload.id);
    if (!id) {
      return;
    }
    if (this.notificationWatermarkRequiresRefresh
      && !this.notificationEventVersions.has(id)
      && !this.notificationTombstones.has(id)) {
      await this.refreshAfterWatermarkFallback(this.lastConversationId);
      return;
    }
    const tombstone = this.notificationTombstones.get(id);
    if (tombstone) {
      const incoming = this.snapshotVersion(payload, this.revision);
      if (compareEventVersion(incoming, tombstone) <= 0) {
        return;
      }

      this.notificationTombstones.delete(id);
    }
    const previous = this.notificationById.get(id);
    const status = stringValue(payload.status) ?? previous?.status ?? "pending";
    const accepted = this.recordEvent(
      this.notificationEventVersions,
      id,
      event.occurredAt,
      readEntityVersion(payload),
      previous?.status,
      status);
    if (!accepted) {
      return;
    }
    if (event.type === "notification.created" && previous) {
      if (previous.status === "pending") {
        await this.markDeliveredIfPending(id);
      }
      return;
    }

    if (status !== "pending" && status !== "delivered") {
      this.deleteNotification(id, accepted);
      return;
    }

    this.notificationById.set(id, {
      ...(previous ?? { id, title: "Jarvis", body: "" }),
      ...payload,
      id,
      status,
      title: stringValue(payload.title) ?? previous?.title ?? "Jarvis",
      body: stringValue(payload.body) ?? previous?.body ?? "",
      actions: Object.hasOwn(payload, "actionsJson")
        ? notificationActionsFrom(payload.actionsJson)
        : previous?.actions ?? []
    });
    if (status === "pending") {
      await this.markDeliveredIfPending(id);
    }
  }

  public async read(notificationId: string): Promise<void> {
    await this.backend.markRead(notificationId, notificationActionIdempotencyKey(notificationId, "read"));
    this.deleteNotification(notificationId);
  }

  public async dismiss(notificationId: string): Promise<void> {
    await this.backend.dismiss(notificationId, notificationActionIdempotencyKey(notificationId, "dismiss"));
    this.deleteNotification(notificationId);
  }

  public async acknowledge(notificationId: string): Promise<void> {
    const notification = this.notificationById.get(notificationId);
    if (!notification?.actions?.includes("acknowledge")) {
      throw new Error("This notification does not offer acknowledge.");
    }
    if (!this.backend.applyAction) {
      throw new Error("Notification actions are not configured.");
    }

    await this.backend.applyAction(
      notificationId,
      "acknowledge",
      notificationActionIdempotencyKey(notificationId, "acknowledge"));
    this.deleteNotification(notificationId);
  }

  private refreshAfterWatermarkFallback(conversationId: string | undefined): Promise<void> {
    if (this.disposed) {
      return Promise.resolve();
    }

    const conversationGeneration = this.conversationGeneration;
    const existing = this.authoritativeRefreshInFlight;
    if (existing
      && existing.conversationId === conversationId
      && existing.conversationGeneration === conversationGeneration) {
      return existing.promise;
    }

    const promise = this.retryAuthoritativeRefresh(conversationId, conversationGeneration);
    const inFlight = { conversationId, conversationGeneration, promise };
    this.authoritativeRefreshInFlight = inFlight;
    void promise.then(
      () => this.clearAuthoritativeRefresh(inFlight),
      () => this.clearAuthoritativeRefresh(inFlight));
    return promise;
  }

  private async retryAuthoritativeRefresh(
    conversationId: string | undefined,
    conversationGeneration: number
  ): Promise<void> {
    let lastError: unknown;
    for (let attempt = 0; attempt < authoritativeRefreshMaxAttempts; attempt++) {
      if (!this.isCurrentRefreshContext(conversationId, conversationGeneration)) {
        return;
      }

      try {
        await this.refresh(conversationId);
        return;
      } catch (reason) {
        lastError = reason;
        if (attempt + 1 >= authoritativeRefreshMaxAttempts) {
          throw reason;
        }

        await this.waitForAuthoritativeRefreshRetry();
      }
    }

    throw lastError ?? new Error("Authoritative task feed refresh failed.");
  }

  private isCurrentRefreshContext(
    conversationId: string | undefined,
    conversationGeneration: number
  ): boolean {
    return !this.disposed
      && this.lastConversationId === conversationId
      && this.conversationGeneration === conversationGeneration;
  }

  private waitForAuthoritativeRefreshRetry(): Promise<void> {
    return new Promise(resolve => {
      this.retryWaiter = resolve;
      this.retryTimer = setTimeout(() => {
        this.retryTimer = undefined;
        this.retryWaiter = undefined;
        resolve();
      }, authoritativeRefreshRetryDelayMs);
    });
  }

  private clearAuthoritativeRefresh(inFlight: {
    conversationId: string | undefined;
    conversationGeneration: number;
    promise: Promise<void>;
  }): void {
    if (this.authoritativeRefreshInFlight === inFlight) {
      this.authoritativeRefreshInFlight = undefined;
    }
  }

  private collectOverlays<T>(
    items: Map<string, T>,
    eventVersions: Map<string, EventVersion>,
    refreshRevision: number
  ): readonly (readonly [string, T])[] {
    return [...items.entries()].filter(([id]) => {
      const version = eventVersions.get(id);
      return version !== undefined && version.revision > refreshRevision;
    });
  }

  private snapshotVersion(value: Record<string, unknown>, revision: number): EventVersion {
    return {
      occurredAt: readSnapshotOccurredAt(value),
      entityVersion: readEntityVersion(value),
      revision
    };
  }

  private seedSnapshot(
    eventVersions: Map<string, EventVersion>,
    id: string,
    snapshotVersion: EventVersion
  ): void {
    const previous = eventVersions.get(id);
    if (previous === undefined || compareEventVersion(snapshotVersion, previous) > 0) {
      eventVersions.set(id, snapshotVersion);
    }
  }

  private recordEvent(
    eventVersions: Map<string, EventVersion>,
    id: string,
    occurredAt: number,
    entityVersion: number | undefined,
    previousStatus?: string,
    incomingStatus?: string
  ): EventVersion | undefined {
    const previous = eventVersions.get(id);
    if (previousStatus && incomingStatus
      && isTerminalTaskStatus(previousStatus)
      && !isTerminalTaskStatus(incomingStatus)) {
      return undefined;
    }

    const incoming = { occurredAt, entityVersion, revision: 0 } satisfies EventVersion;
    if (previous !== undefined && compareEventVersion(incoming, previous) <= 0) {
      return undefined;
    }

    const accepted = { ...incoming, revision: ++this.revision };
    eventVersions.set(id, accepted);
    this.trimTrackedVersions();
    return accepted;
  }

  private deleteNotification(notificationId: string, eventVersion?: EventVersion): void {
    this.notificationById.delete(notificationId);
    if (this.notificationTombstones.has(notificationId)) {
      return;
    }

    const previous = this.notificationEventVersions.get(notificationId);
    this.notificationTombstones.set(notificationId, {
      occurredAt: eventVersion?.occurredAt ?? previous?.occurredAt ?? 0,
      entityVersion: eventVersion?.entityVersion ?? previous?.entityVersion,
      revision: ++this.revision
    });
    this.trimTrackedVersions();
  }

  private trimTrackedVersions(): void {
    while (this.taskEventVersions.size > maxTrackedFeedEntities) {
      const oldest = oldestVersionEntry(this.taskEventVersions);
      if (!oldest) {
        break;
      }

      this.taskEventVersions.delete(oldest[0]);
      this.taskWatermarkRequiresRefresh = true;
    }

    while (this.notificationEventVersions.size + this.notificationTombstones.size
      - countSharedKeys(this.notificationEventVersions, this.notificationTombstones)
      > maxTrackedFeedEntities) {
      const oldest = oldestNotificationVersionEntry(
        this.notificationEventVersions,
        this.notificationTombstones);
      if (!oldest) {
        break;
      }

      if (oldest[2] === "tombstone") {
        this.notificationTombstones.delete(oldest[0]);
      } else {
        this.notificationEventVersions.delete(oldest[0]);
      }
      this.notificationWatermarkRequiresRefresh = true;
    }
  }

  private markDeliveredIfPending(notificationId: string): Promise<void> {
    const notification = this.notificationById.get(notificationId);
    if (!notification || notification.status !== "pending") {
      return Promise.resolve();
    }

    const existingDelivery = this.deliveryInFlight.get(notificationId);
    if (existingDelivery) {
      return existingDelivery;
    }

    const actionKey = notificationDeliveredActionKey(notificationId);
    const delivery = (this.backend.runAction
      ? this.backend.runAction(actionKey, idempotencyKey =>
        this.backend.markDelivered(notificationId, idempotencyKey))
      : this.backend.markDelivered(notificationId, notificationDeliveredIdempotencyKey(notificationId)))
      .then(() => {
        const current = this.notificationById.get(notificationId);
        if (current?.status === "pending") {
          this.notificationById.set(notificationId, { ...current, status: "delivered" });
        }
      })
      .catch(() => {
        // Keep the pending notification so the next refresh/reconnect retries it.
      })
      .finally(() => {
        this.deliveryInFlight.delete(notificationId);
      });
    this.deliveryInFlight.set(notificationId, delivery);
    return delivery;
  }
}

export function ensureActiveDesktopTaskNotificationFeed(
  feed: DesktopTaskNotificationFeed | undefined,
  create: () => DesktopTaskNotificationFeed
): DesktopTaskNotificationFeed {
  return feed && !feed.isDisposed ? feed : create();
}

function normalizeTaskPage(value: DesktopTaskPageResult): DesktopTaskPage {
  if (Array.isArray(value)) {
    return {
      items: value.map(desktopTaskFrom).filter((task): task is DesktopTask => task !== undefined),
      nextCursor: null
    };
  }

  const item = record(value);
  if (!item || !Array.isArray(item.items)) {
    throw new Error("Backend returned an invalid task page.");
  }

  const nextCursor = item.nextCursor;
  if (nextCursor === undefined || nextCursor === null) {
    return {
      items: item.items.map(desktopTaskFrom).filter((task): task is DesktopTask => task !== undefined),
      nextCursor: null
    };
  }

  if (typeof nextCursor !== "string" || nextCursor.length === 0 || nextCursor.length > 200) {
    throw new Error("Backend returned an invalid task cursor.");
  }

  return {
    items: item.items.map(desktopTaskFrom).filter((task): task is DesktopTask => task !== undefined),
    nextCursor
  };
}

function readEntityVersion(payload: Record<string, unknown>): number | undefined {
  const value = payload.entityVersion;
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : undefined;
}

function readSnapshotOccurredAt(value: Record<string, unknown>): number {
  for (const key of ["completedAtMs", "readAtMs", "deliveredAtMs", "createdAtMs"]) {
    const candidate = value[key];
    if (typeof candidate === "number" && Number.isFinite(candidate)) {
      return candidate;
    }
  }

  return 0;
}

function compareEventVersion(left: EventVersion, right: EventVersion): number {
  if (left.entityVersion !== undefined && right.entityVersion !== undefined) {
    if (left.entityVersion !== right.entityVersion) {
      return left.entityVersion - right.entityVersion;
    }

    return 0;
  }

  if (left.entityVersion !== undefined && right.entityVersion === undefined) {
    return 1;
  }

  if (left.entityVersion === undefined && right.entityVersion !== undefined) {
    return -1;
  }

  return left.occurredAt - right.occurredAt;
}

function isTerminalTaskStatus(status: string): boolean {
  return status === "succeeded" || status === "failed" || status === "cancelled";
}

function oldestVersionEntry(
  versions: Map<string, EventVersion>
): readonly [string, EventVersion] | undefined {
  let oldest: readonly [string, EventVersion] | undefined;
  for (const entry of versions.entries()) {
    if (!oldest || entry[1].revision < oldest[1].revision) {
      oldest = entry;
    }
  }
  return oldest;
}

function countSharedKeys(
  left: Map<string, EventVersion>,
  right: Map<string, EventVersion>
): number {
  let count = 0;
  for (const id of left.keys()) {
    if (right.has(id)) {
      count++;
    }
  }
  return count;
}

function oldestNotificationVersionEntry(
  eventVersions: Map<string, EventVersion>,
  tombstones: Map<string, EventVersion>
): readonly [string, EventVersion, "event" | "tombstone"] | undefined {
  let oldest: readonly [string, EventVersion, "event" | "tombstone"] | undefined;
  for (const [id, version] of eventVersions.entries()) {
    if (!oldest || version.revision < oldest[1].revision) {
      oldest = [id, version, "event"];
    }
  }
  for (const [id, version] of tombstones.entries()) {
    if (!oldest || version.revision < oldest[1].revision) {
      oldest = [id, version, "tombstone"];
    }
  }
  return oldest;
}
