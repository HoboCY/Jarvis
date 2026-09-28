import { randomUUID } from "node:crypto";
import type { Stats } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  open,
  readFile,
  realpath,
  rename,
  rm
} from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";

const schemaVersion = 1;
const selectionDirectoryName = "desktop";
const selectionFileName = "conversation-selection.json";
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const utcPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

export type DesktopConversationSelection = {
  schemaVersion: 1;
  conversationId: string;
  updatedAt: string;
};

type SelectionPaths = {
  root: string;
  directory: string;
  file: string;
};

export class DesktopConversationSelectionStore {
  private readonly userDataDirectory: string;
  private readonly now: () => Date;

  public constructor(userDataDirectory: string, now: () => Date = () => new Date()) {
    if (!isAbsolute(userDataDirectory)) {
      throw invalidStorage();
    }
    this.userDataDirectory = resolve(userDataDirectory);
    this.now = now;
  }

  public async get(): Promise<DesktopConversationSelection | undefined> {
    const paths = await this.resolveStorage(false);
    if (!paths) {
      return undefined;
    }
    const metadata = await lstatOrMissing(paths.file);
    if (!metadata) {
      return undefined;
    }
    assertOwnedRegularFile(metadata);
    let value: unknown;
    try {
      value = JSON.parse(await readFile(paths.file, "utf8"));
    } catch {
      throw invalidSelection();
    }
    return validateSelection(value);
  }

  public async set(conversationId: string): Promise<DesktopConversationSelection> {
    if (typeof conversationId !== "string" || !uuidPattern.test(conversationId)) {
      throw new Error("Conversation id is invalid.");
    }
    const paths = await this.resolveStorage(true);
    if (!paths) {
      throw invalidStorage();
    }
    const selection: DesktopConversationSelection = {
      schemaVersion,
      conversationId,
      updatedAt: this.now().toISOString()
    };
    validateSelection(selection);

    const existing = await lstatOrMissing(paths.file);
    if (existing) {
      assertOwnedRegularFile(existing);
    }

    const temporary = join(paths.directory, `.conversation-selection-${randomUUID()}.tmp`);
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      handle = await open(temporary, "wx", 0o600);
      await handle.writeFile(`${JSON.stringify(selection)}\n`, "utf8");
      await handle.sync();
      await handle.close();
      handle = undefined;
      await chmod(temporary, 0o600);
      const target = await lstatOrMissing(paths.file);
      if (target) {
        assertOwnedRegularFile(target);
      }
      await rename(temporary, paths.file);
      await syncDirectory(paths.directory);
      return selection;
    } finally {
      await handle?.close().catch(() => {});
      await rm(temporary, { force: true }).catch(() => {});
    }
  }

  public async clear(): Promise<void> {
    const paths = await this.resolveStorage(false);
    if (!paths) {
      return;
    }
    const metadata = await lstatOrMissing(paths.file);
    if (!metadata) {
      return;
    }
    assertOwnedRegularFile(metadata);
    await rm(paths.file);
    await syncDirectory(paths.directory);
  }

  private async resolveStorage(create: boolean): Promise<SelectionPaths | undefined> {
    const paths: SelectionPaths = {
      root: this.userDataDirectory,
      directory: join(this.userDataDirectory, selectionDirectoryName),
      file: join(this.userDataDirectory, selectionDirectoryName, selectionFileName)
    };
    if (!isWithin(paths.root, paths.directory) || !isWithin(paths.directory, paths.file)) {
      throw invalidStorage();
    }

    let rootMetadata = await lstatOrMissing(paths.root);
    if (!rootMetadata) {
      if (!create) {
        return undefined;
      }
      await mkdir(paths.root, { recursive: true, mode: 0o700 });
      rootMetadata = await lstatOrMissing(paths.root);
    }
    if (!rootMetadata || rootMetadata.isSymbolicLink() || !rootMetadata.isDirectory()) {
      throw invalidStorage();
    }
    assertOwnedDirectory(rootMetadata);
    await chmod(paths.root, 0o700);
    const rootRealPath = await realpath(paths.root).catch(() => undefined);
    if (!rootRealPath) {
      throw invalidStorage();
    }

    let directoryMetadata = await lstatOrMissing(paths.directory);
    if (!directoryMetadata) {
      if (!create) {
        return undefined;
      }
      await mkdir(paths.directory, { recursive: false, mode: 0o700 });
      directoryMetadata = await lstatOrMissing(paths.directory);
    }
    if (!directoryMetadata || directoryMetadata.isSymbolicLink() || !directoryMetadata.isDirectory()) {
      throw invalidStorage();
    }
    assertOwnedDirectory(directoryMetadata);
    await chmod(paths.directory, 0o700);
    const directoryRealPath = await realpath(paths.directory).catch(() => undefined);
    if (!directoryRealPath || !isWithin(rootRealPath, directoryRealPath)) {
      throw invalidStorage();
    }
    return paths;
  }
}

function validateSelection(value: unknown): DesktopConversationSelection {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw invalidSelection();
  }
  const item = value as Record<string, unknown>;
  if (Object.keys(item).sort().join(",") !== "conversationId,schemaVersion,updatedAt"
    || item.schemaVersion !== schemaVersion
    || typeof item.conversationId !== "string"
    || !uuidPattern.test(item.conversationId)
    || typeof item.updatedAt !== "string"
    || !utcPattern.test(item.updatedAt)
    || !Number.isFinite(Date.parse(item.updatedAt))) {
    throw invalidSelection();
  }
  return item as DesktopConversationSelection;
}

function assertOwnedDirectory(metadata: { uid?: number | bigint; mode: number }): void {
  if (!ownerMatches(metadata.uid)) {
    throw invalidStorage();
  }
}

function assertOwnedRegularFile(metadata: {
  uid?: number | bigint;
  mode: number;
  isFile: () => boolean;
  isSymbolicLink: () => boolean;
}): void {
  if (metadata.isSymbolicLink() || !metadata.isFile() || !ownerMatches(metadata.uid)
    || (metadata.mode & 0o777) !== 0o600) {
    throw invalidStorage();
  }
}

function ownerMatches(uid: number | bigint | undefined): boolean {
  const currentUid = process.getuid?.();
  return currentUid === undefined || uid === currentUid
    || typeof uid === "bigint" && BigInt(currentUid) === uid;
}

async function syncDirectory(directory: string): Promise<void> {
  const handle = await open(directory, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function isWithin(root: string, child: string): boolean {
  const path = relative(resolve(root), resolve(child));
  return path.length === 0 || !path.startsWith("..") && !isAbsolute(path);
}

function invalidStorage(): Error {
  return new Error("Conversation selection storage is invalid.");
}

function invalidSelection(): Error {
  return new Error("Conversation selection is invalid.");
}

async function lstatOrMissing(path: string): Promise<Stats | undefined> {
  try {
    return await lstat(path, { bigint: false }) as Stats;
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return undefined;
    }
    throw invalidStorage();
  }
}

function isNodeError(value: unknown): value is NodeJS.ErrnoException {
  return value instanceof Error && "code" in value;
}
