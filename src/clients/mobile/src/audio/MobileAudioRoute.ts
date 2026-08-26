export type AudioRoute = "system" | "speaker" | "headset" | "bluetooth" | "unknown";

export interface NativeAudioRouteBoundary {
  requestMicrophonePermission: () => Promise<"granted" | "denied">;
  startCallAudio: () => Promise<void>;
  stopCallAudio: () => Promise<void>;
  getOutputRoute: () => AudioRoute;
  setOutputRoute: (route: "system" | "speaker") => Promise<AudioRoute>;
  subscribeOutputRoute: (listener: (route: AudioRoute) => void) => () => void;
}

/** Keeps React components independent from native audio/session APIs. */
export class MobileAudioRoute {
  private activeValue = false;
  private lifecycle = 0;
  private outputRouteValue: AudioRoute = "unknown";
  private requestedOutputPolicyValue: "system" | "speaker" = "system";
  private readonly listeners = new Set<(route: AudioRoute) => void>();
  private readonly unsubscribeNative: () => void;

  public constructor(private readonly boundary: NativeAudioRouteBoundary) {
    this.outputRouteValue = boundary.getOutputRoute();
    this.unsubscribeNative = boundary.subscribeOutputRoute(route => {
      this.outputRouteValue = route;
      for (const listener of this.listeners) {
        listener(route);
      }
    });
  }

  public get active(): boolean {
    return this.activeValue;
  }

  public get outputRoute(): AudioRoute {
    return this.outputRouteValue;
  }

  /** The policy most recently requested from the native call-audio adapter. */
  public get requestedOutputPolicy(): "system" | "speaker" {
    return this.requestedOutputPolicyValue;
  }

  public async start(): Promise<void> {
    if (this.activeValue) {
      return;
    }
    const attempt = ++this.lifecycle;
    const permission = await this.boundary.requestMicrophonePermission();
    this.assertCurrentStart(attempt);
    if (permission !== "granted") {
      throw new Error("Microphone permission is required for a voice call.");
    }
    await this.boundary.startCallAudio();
    if (this.lifecycle !== attempt) {
      await this.boundary.stopCallAudio().catch(() => undefined);
      throw new Error("Mobile call audio startup was cancelled.");
    }
    this.outputRouteValue = this.boundary.getOutputRoute();
    this.assertCurrentStart(attempt);
    this.activeValue = true;
  }

  public async stop(): Promise<void> {
    ++this.lifecycle;
    if (!this.activeValue) {
      return;
    }
    this.activeValue = false;
    await this.boundary.stopCallAudio();
  }

  public async setOutputRoute(route: "system" | "speaker"): Promise<AudioRoute> {
    this.requestedOutputPolicyValue = route;
    const selected = await this.boundary.setOutputRoute(route);
    // The boundary return value is an observation, not an acknowledgement that
    // the requested policy was applied. Native adapters return "unknown" when
    // no reliable route observation is available yet.
    this.outputRouteValue = selected;
    return selected;
  }

  public onRouteChanged(listener: (route: AudioRoute) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  public dispose(): void {
    ++this.lifecycle;
    this.unsubscribeNative();
    this.listeners.clear();
  }

  private assertCurrentStart(attempt: number): void {
    if (this.lifecycle !== attempt) {
      throw new Error("Mobile call audio startup was cancelled.");
    }
  }
}
