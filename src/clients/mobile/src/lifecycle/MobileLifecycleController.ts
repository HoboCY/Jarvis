export type MobileAppState = "active" | "inactive" | "background" | "unknown";

export interface MobileAppStateSource {
  state: MobileAppState;
  subscribe: (listener: (state: MobileAppState) => void) => () => void;
}

export interface MobileLifecycleRuntime {
  refreshAuth: () => Promise<boolean>;
  recoverHttpState: () => Promise<void>;
  connectRealtime: () => Promise<void>;
  disconnectRealtime: () => Promise<void>;
  connectSignalR: () => Promise<void>;
  disconnectSignalR: () => Promise<void>;
  stopAudio: () => Promise<void>;
}

export type MobileLifecycleOptions = {
  onError?: (error: unknown) => void;
};

/** Serializes foreground/background transitions so duplicate AppState events are harmless. */
export class MobileLifecycleController {
  private readonly unsubscribe: () => void;
  private transition: Promise<void> = Promise.resolve();
  private foreground = false;
  private disposed = false;

  public constructor(
    private readonly source: MobileAppStateSource,
    private readonly runtime: MobileLifecycleRuntime,
    private readonly options: MobileLifecycleOptions = {}
  ) {
    this.unsubscribe = source.subscribe(state => this.handleState(state));
  }

  public async start(): Promise<void> {
    if (this.source.state === "active") {
      this.handleState("active");
    }
    await this.whenIdle();
  }

  /** Re-runs foreground recovery after authentication changes, such as pairing. */
  public async recoverForeground(): Promise<void> {
    if (this.disposed || this.source.state !== "active") {
      return;
    }
    if (!this.foreground) {
      this.foreground = true;
    }
    this.enqueue(() => this.enterForeground());
    await this.whenIdle();
  }

  public async whenIdle(): Promise<void> {
    await this.transition;
  }

  public dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.unsubscribe();
    if (this.foreground) {
      this.enqueue(() => this.leaveForeground());
    }
  }

  private handleState(state: MobileAppState): void {
    if (this.disposed) {
      return;
    }
    if (state === "active" && !this.foreground) {
      this.foreground = true;
      this.enqueue(() => this.enterForeground());
    } else if (state !== "active" && this.foreground) {
      this.foreground = false;
      this.enqueue(() => this.leaveForeground());
    }
  }

  private enqueue(action: () => Promise<void>): void {
    this.transition = this.transition
      .then(action)
      .catch(error => {
        this.options.onError?.(error);
      });
  }

  private async enterForeground(): Promise<void> {
    if (!await this.runtime.refreshAuth()) {
      return;
    }
    await this.runtime.recoverHttpState();
    await this.runtime.connectSignalR();
    await this.runtime.connectRealtime();
  }

  private async leaveForeground(): Promise<void> {
    await Promise.allSettled([
      this.runtime.stopAudio(),
      this.runtime.disconnectRealtime(),
      this.runtime.disconnectSignalR()
    ]);
  }
}
