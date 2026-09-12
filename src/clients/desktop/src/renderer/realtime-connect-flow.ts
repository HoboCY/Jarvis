import type { DesktopRealtimeStatus } from "./realtime.js";

export class RealtimeConnectGate {
  private inFlight: Promise<void> | undefined;
  private frozen = false;

  public get isRunning(): boolean {
    return this.inFlight !== undefined;
  }

  public get isFrozen(): boolean {
    return this.frozen;
  }

  public freeze(): void {
    this.frozen = true;
  }

  public run(connect: () => Promise<void>): Promise<void> {
    if (this.frozen) {
      return Promise.reject(new Error("Realtime shutdown is already in progress."));
    }
    if (this.inFlight) {
      return this.inFlight;
    }

    const attempt = Promise.resolve().then(connect);
    const tracked = attempt.finally(() => {
      if (this.inFlight === tracked) {
        this.inFlight = undefined;
      }
    });
    this.inFlight = tracked;
    return tracked;
  }

  public async waitForCompletion(timeoutMs = 5_000): Promise<boolean> {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 5_000) {
      throw new RangeError("Realtime connection wait timeout is invalid.");
    }
    const inFlight = this.inFlight;
    if (!inFlight) {
      return true;
    }

    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<boolean>(resolve => {
      timer = setTimeout(() => resolve(false), timeoutMs);
      timer.unref?.();
    });
    const result = await Promise.race([
      inFlight.then(() => true, () => false),
      timeout
    ]);
    if (timer) {
      clearTimeout(timer);
    }
    return result;
  }
}

/**
 * Startup voice connection is a one-shot attempt. Manual retries continue to
 * use RealtimeConnectGate directly after this attempt has settled.
 */
export class RealtimeAutoConnectGate {
  private attempted = false;

  public constructor(private readonly connectGate: RealtimeConnectGate) {}

  public run(connect: () => Promise<void>): Promise<void> | undefined {
    if (this.attempted) {
      return this.connectGate.isRunning ? this.connectGate.run(connect) : undefined;
    }

    this.attempted = true;
    return this.connectGate.run(connect);
  }
}

export function canSendRealtimeText(
  status: DesktopRealtimeStatus,
  connectInFlight: boolean
): boolean {
  return status === "connected" && !connectInFlight;
}
