export const builtInWakeWord = "贾维斯" as const;

export type WakeWordState = "stopped" | "starting" | "listening" | "error";

export type WakeWordDetector = {
  readonly state: WakeWordState;
  start: () => Promise<void>;
  stop: () => Promise<void>;
  onDetected: (listener: () => void) => () => void;
  onStateChange: (listener: (state: WakeWordState) => void) => () => void;
};

export type WakeWordBridge = {
  startWakeWordDetection: (keyword: string) => Promise<void>;
  stopWakeWordDetection: () => Promise<void>;
  onWakeWordDetected: (listener: () => void) => () => void;
  onWakeWordError: (listener: (message: string) => void) => () => void;
};

export class WakeWordStartCancelledError extends Error {
  public constructor() {
    super("Wake-word detector start was cancelled.");
    this.name = "WakeWordStartCancelledError";
  }
}

export class IpcWakeWordDetector implements WakeWordDetector {
  private stateValue: WakeWordState = "stopped";
  private removeBridgeDetection: (() => void) | undefined;
  private removeBridgeError: (() => void) | undefined;
  private readonly detectionListeners = new Set<() => void>();
  private readonly stateListeners = new Set<(state: WakeWordState) => void>();
  private startGeneration = 0;

  public constructor(
    private readonly bridge: WakeWordBridge,
    private readonly keyword: typeof builtInWakeWord
  ) {}

  public get state(): WakeWordState {
    return this.stateValue;
  }

  public onDetected(listener: () => void): () => void {
    this.detectionListeners.add(listener);
    return () => this.detectionListeners.delete(listener);
  }

  public onStateChange(listener: (state: WakeWordState) => void): () => void {
    this.stateListeners.add(listener);
    return () => this.stateListeners.delete(listener);
  }

  public async start(): Promise<void> {
    if (this.stateValue === "starting" || this.stateValue === "listening") {
      return;
    }

    const generation = ++this.startGeneration;
    this.setState("starting");
    this.removeBridgeDetection = this.bridge.onWakeWordDetected(() => {
      if (this.stateValue !== "listening") {
        return;
      }
      for (const listener of this.detectionListeners) {
        listener();
      }
    });
    this.removeBridgeError = this.bridge.onWakeWordError(() => {
      if (generation !== this.startGeneration) {
        return;
      }
      // The main process stops native capture before publishing this event.
      // Detach the old bridge callbacks so a later explicit retry cannot
      // deliver one detection through multiple generations.
      this.startGeneration++;
      this.releaseBridgeListeners();
      this.setState("error");
    });

    try {
      await this.bridge.startWakeWordDetection(this.keyword);
      if (generation !== this.startGeneration) {
        throw new WakeWordStartCancelledError();
      }
      this.setState("listening");
    } catch (error) {
      if (generation !== this.startGeneration) {
        throw error;
      }
      this.startGeneration++;
      this.releaseBridgeListeners();
      try {
        await this.bridge.stopWakeWordDetection();
      } catch {
        // Preserve the startup failure while still attempting local cleanup.
      }
      this.setState("error");
      throw error;
    }
  }

  public async stop(): Promise<void> {
    if (this.stateValue === "stopped" && !this.removeBridgeDetection && !this.removeBridgeError) {
      return;
    }

    this.startGeneration++;
    this.releaseBridgeListeners();
    try {
      await this.bridge.stopWakeWordDetection();
    } finally {
      this.setState("stopped");
    }
  }

  private releaseBridgeListeners(): void {
    this.removeBridgeDetection?.();
    this.removeBridgeError?.();
    this.removeBridgeDetection = undefined;
    this.removeBridgeError = undefined;
  }

  private setState(state: WakeWordState): void {
    if (this.stateValue === state) {
      return;
    }
    this.stateValue = state;
    for (const listener of this.stateListeners) {
      listener(state);
    }
  }
}

export function createSherpaWakeWordDetector(
  bridge: WakeWordBridge,
  keyword: string
): WakeWordDetector {
  if (keyword !== builtInWakeWord) {
    throw new Error(`Unsupported wake word: ${keyword}`);
  }
  return new IpcWakeWordDetector(bridge, keyword);
}
