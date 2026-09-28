export async function ensureConversation<T>(
  current: T | undefined,
  create: () => Promise<T | undefined>
): Promise<T | undefined> {
  return current ?? create();
}

export type ConversationRestoreResult<T> =
  | { status: "restored"; conversation: T }
  | { status: "created"; conversation: T }
  | { status: "retryable"; conversationId?: string };

export type ConversationSelectionSnapshot = {
  generation: number;
  bindingEpoch: number;
  conversationId: string;
};

export type RestoreSelectedConversationOptions<T> = {
  readSelection: () => Promise<unknown>;
  load: (conversationId: string) => Promise<T>;
  clear: () => Promise<void>;
  create: () => Promise<T | undefined>;
  isNotFound: (error: unknown) => boolean;
};

/**
 * Serializes renderer-owned selection writes and gives each conversation
 * operation a generation.  A late response from an older operation can then
 * be observed, but cannot change the active conversation or overwrite the
 * selection chosen by a newer operation.
 */
export class ConversationSelectionOperationCoordinator {
  private generation = 0;
  private bindingEpoch = 0;
  private activeConversationId: string | undefined;
  private boundConversationId: string | undefined;
  private persistedConversationId: string | undefined;
  private selectionMutation: Promise<void> = Promise.resolve();
  private latestOperation: Promise<unknown> | undefined;

  public get currentGeneration(): number {
    return this.generation;
  }

  public begin(): number {
    this.generation++;
    return this.generation;
  }

  public isCurrent(generation: number): boolean {
    return this.generation === generation;
  }

  public capture(conversationId: string): ConversationSelectionSnapshot {
    return {
      generation: this.generation,
      bindingEpoch: this.bindingEpoch,
      conversationId
    };
  }

  public owns(
    snapshot: ConversationSelectionSnapshot,
    activeConversationId: string | undefined,
    shutdownStarted: boolean
  ): boolean {
    return !shutdownStarted
      && snapshot.bindingEpoch === this.bindingEpoch
      && this.activeConversationId === snapshot.conversationId
      && activeConversationId === snapshot.conversationId;
  }

  public markActive(conversationId: string, generation?: number): boolean {
    if (generation !== undefined && !this.isCurrent(generation)) {
      return false;
    }
    if (this.activeConversationId !== conversationId) {
      this.persistedConversationId = undefined;
    }
    this.activeConversationId = conversationId;
    return true;
  }

  public isPersisted(conversationId: string): boolean {
    return this.activeConversationId === conversationId
      && this.persistedConversationId === conversationId;
  }

  public async persist(
    generation: number,
    conversationId: string,
    write: () => Promise<unknown>
  ): Promise<boolean> {
    const mutation = this.selectionMutation
      .catch(() => undefined)
      .then(async () => {
        if (!this.isCurrent(generation) || this.activeConversationId !== conversationId) {
          return false;
        }
        await write();
        if (!this.isCurrent(generation) || this.activeConversationId !== conversationId) {
          return false;
        }
        this.persistedConversationId = conversationId;
        this.commitBinding(conversationId);
        return true;
      });
    this.selectionMutation = mutation.then(() => undefined, () => undefined);
    return await mutation;
  }

  public async clear(
    generation: number,
    clearSelection: () => Promise<void>
  ): Promise<boolean> {
    const mutation = this.selectionMutation
      .catch(() => undefined)
      .then(async () => {
        if (!this.isCurrent(generation)) {
          return false;
        }
        await clearSelection();
        if (!this.isCurrent(generation)) {
          return false;
        }
        this.persistedConversationId = undefined;
        return true;
      });
    this.selectionMutation = mutation.then(() => undefined, () => undefined);
    return await mutation;
  }

  public track<T>(operation: () => Promise<T>): Promise<T> {
    const tracked = Promise.resolve().then(operation);
    this.latestOperation = tracked;
    return tracked;
  }

  public async waitForLatest(): Promise<void> {
    let observed: Promise<unknown> | undefined;
    while (this.latestOperation !== undefined && this.latestOperation !== observed) {
      observed = this.latestOperation;
      await observed.catch(() => undefined);
    }
  }

  public markPersisted(conversationId: string, generation?: number): boolean {
    if (generation !== undefined && !this.isCurrent(generation)) {
      return false;
    }
    if (this.activeConversationId !== conversationId) {
      return false;
    }
    this.persistedConversationId = conversationId;
    this.commitBinding(conversationId);
    return true;
  }

  public resetActive(generation?: number): boolean {
    if (generation !== undefined && !this.isCurrent(generation)) {
      return false;
    }
    this.activeConversationId = undefined;
    this.persistedConversationId = undefined;
    if (this.boundConversationId !== undefined) {
      this.bindingEpoch++;
      this.boundConversationId = undefined;
    }
    return true;
  }

  private commitBinding(conversationId: string): void {
    if (this.boundConversationId === conversationId) {
      return;
    }
    this.bindingEpoch++;
    this.boundConversationId = conversationId;
  }
}

const conversationIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const updatedAtPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

export async function restoreSelectedConversation<T>({
  readSelection,
  load,
  clear,
  create,
  isNotFound
}: RestoreSelectedConversationOptions<T>): Promise<ConversationRestoreResult<T>> {
  const conversationId = selectedConversationId(await readSelection());
  if (!conversationId) {
    const conversation = await create();
    return conversation ? { status: "created", conversation } : { status: "retryable" };
  }

  try {
    return { status: "restored", conversation: await load(conversationId) };
  } catch (error) {
    if (!isNotFound(error)) {
      return { status: "retryable", conversationId };
    }
    try {
      await clear();
    } catch {
      return { status: "retryable", conversationId };
    }
    const conversation = await create();
    return conversation
      ? { status: "created", conversation }
      : { status: "retryable" };
  }
}

function selectedConversationId(value: unknown): string | undefined {
  if (value === null || value === undefined) {
    return undefined;
  }
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Stored conversation selection is invalid.");
  }
  const item = value as Record<string, unknown>;
  if (Object.keys(item).sort().join(",") !== "conversationId,schemaVersion,updatedAt"
    || item.schemaVersion !== 1
    || typeof item.conversationId !== "string"
    || !conversationIdPattern.test(item.conversationId)
    || typeof item.updatedAt !== "string"
    || !updatedAtPattern.test(item.updatedAt)
    || !Number.isFinite(Date.parse(item.updatedAt))) {
    throw new Error("Stored conversation selection is invalid.");
  }
  return item.conversationId;
}
