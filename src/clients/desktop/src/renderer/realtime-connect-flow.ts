import type { DesktopRealtimeStatus } from "./realtime.js";

export class RealtimeConnectGate {
  private inFlight: Promise<void> | undefined;

  public get isRunning(): boolean {
    return this.inFlight !== undefined;
  }

  public run(connect: () => Promise<void>): Promise<void> {
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
