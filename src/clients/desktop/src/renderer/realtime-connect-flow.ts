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

export function canSendRealtimeText(
  status: DesktopRealtimeStatus,
  connectInFlight: boolean
): boolean {
  return status === "connected" && !connectInFlight;
}
