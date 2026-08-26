import { secureWebPreferences } from "./security.js";

export type TrayCommand = "show" | "hide" | "quit";

export type SafeNotificationProjection = {
  id: string;
  title: string;
  body: string;
};

export function shouldHideWindowOnClose(isQuitting: boolean): boolean {
  return !isQuitting;
}

export function getTrayCommands(isWindowVisible: boolean): TrayCommand[] {
  return [isWindowVisible ? "hide" : "show", "quit"];
}

export function createOverlayWindowOptions(preloadPath: string) {
  return {
    width: 420,
    height: 180,
    show: false,
    frame: false,
    resizable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    webPreferences: {
      ...secureWebPreferences,
      preload: preloadPath
    }
  } as const;
}

export class NotificationProjectionCache {
  private readonly seen = new Set<string>();

  public accept(value: unknown): SafeNotificationProjection | undefined {
    const projection = projectNotification(value);
    if (!projection || this.seen.has(projection.id)) {
      return undefined;
    }

    this.seen.add(projection.id);
    return projection;
  }
}

function projectNotification(value: unknown): SafeNotificationProjection | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }

  const item = value as Record<string, unknown>;
  const id = boundedIdentifier(item.id);
  const title = boundedText(item.title, 200);
  const body = boundedText(item.body, 1_000);
  if (!id || !title || !body) {
    return undefined;
  }

  return { id, title, body };
}

function boundedIdentifier(value: unknown): string | undefined {
  if (typeof value !== "string"
    || value.length === 0
    || value.length > 200
    || !/^[A-Za-z0-9._:-]+$/.test(value)) {
    return undefined;
  }

  return value;
}

function boundedText(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const withoutScripts = value.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ");
  const withoutMarkup = withoutScripts.replace(/<[^>]*>/g, " ");
  const withoutSecrets = withoutMarkup
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, "[REDACTED]")
    .replace(/\b(?:sk|ek|rk|sess)[-_][A-Za-z0-9_-]+/gi, "[REDACTED]")
    .replace(/(?:[A-Z]:\\|\/(?:Users|home|private|tmp|var\/folders)\/)[^\s"']+/gi, "[REDACTED_PATH]");
  const withoutControlCharacters = [...withoutSecrets]
    .map((character) => {
      const code = character.charCodeAt(0);
      return code < 0x20 || code === 0x7f ? " " : character;
    })
    .join("");
  const normalized = withoutControlCharacters
    .replace(/\s+/g, " ")
    .trim();
  return normalized.length > 0 ? normalized.slice(0, maxLength) : undefined;
}
