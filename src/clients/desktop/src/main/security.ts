export const secureWebPreferences = {
  contextIsolation: true,
  nodeIntegration: false,
  sandbox: true,
  webSecurity: true
} as const;

export function isAllowedNavigation(url: string, rendererEntryUrl: string): boolean {
  if (url !== rendererEntryUrl) {
    return false;
  }

  try {
    const entry = new URL(rendererEntryUrl);
    if (entry.protocol === "file:") {
      return true;
    }

    return (
      (entry.protocol === "http:" || entry.protocol === "https:") &&
      new Set(["localhost", "127.0.0.1", "[::1]"]).has(entry.hostname)
    );
  } catch {
    return false;
  }
}

export function isAllowedExternalUrl(url: string): boolean {
  try {
    const protocol = new URL(url).protocol;
    return protocol === "http:" || protocol === "https:";
  } catch {
    return false;
  }
}

export function getRendererEntryUrl(isPackaged: boolean, developmentUrl?: string): string {
  if (!isPackaged && developmentUrl !== undefined) {
    const url = new URL(developmentUrl);
    const isLocalHttpUrl =
      (url.protocol === "http:" || url.protocol === "https:") &&
      new Set(["localhost", "127.0.0.1", "[::1]"]).has(url.hostname);

    if (!isLocalHttpUrl) {
      throw new Error("The development renderer URL must be a local HTTP(S) URL.");
    }

    return url.href;
  }

  return new URL("../renderer/index.html", import.meta.url).href;
}
