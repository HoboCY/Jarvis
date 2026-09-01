import { BuiltInKeyword, PorcupineWorker } from "@picovoice/porcupine-web/dist/esm/index.js";
import { WebVoiceProcessor } from "@picovoice/web-voice-processor/dist/esm/index.js";

type PvEngine = {
  onmessage?: ((event: MessageEvent) => unknown) | null;
  postMessage?: (event: unknown) => void;
  worker?: {
    onmessage?: ((event: MessageEvent) => unknown) | null;
    postMessage?: (event: unknown) => void;
  };
};

export const builtInWakeWord = "Jarvis" as const;

export type WakeWordState = "stopped" | "starting" | "listening" | "error";

export type WakeWordEngine = {
  release: () => Promise<void>;
  terminate: () => void;
  worker?: unknown;
};

export type WakeWordProcessor = {
  subscribe: (engine: WakeWordEngine) => Promise<void>;
  unsubscribe: (engine: WakeWordEngine) => Promise<void>;
};

export type WakeWordDetector = {
  readonly state: WakeWordState;
  start: () => Promise<void>;
  stop: () => Promise<void>;
  onDetected: (listener: () => void) => () => void;
  onStateChange: (listener: (state: WakeWordState) => void) => () => void;
};

export type WakeWordEngineFactory = (onDetected: () => void) => Promise<WakeWordEngine>;

export class WakeWordDetectorAdapter implements WakeWordDetector {
  private engine: WakeWordEngine | undefined;
  private subscribed = false;
  private stateValue: WakeWordState = "stopped";
  private readonly detectionListeners = new Set<() => void>();
  private readonly stateListeners = new Set<(state: WakeWordState) => void>();

  public constructor(
    private readonly createEngine: WakeWordEngineFactory,
    private readonly processor: WakeWordProcessor
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

    this.setState("starting");
    let engine: WakeWordEngine | undefined;
    try {
      engine = await this.createEngine(() => {
        if (this.stateValue !== "listening") {
          return;
        }
        for (const listener of this.detectionListeners) {
          listener();
        }
      });
      this.subscribed = true;
      await this.processor.subscribe(engine);
      this.engine = engine;
      this.setState("listening");
    } catch (error) {
      await this.releaseEngine(engine, true);
      this.subscribed = false;
      this.setState("error");
      throw error;
    }
  }

  public async stop(): Promise<void> {
    const engine = this.engine;
    if (!engine && this.stateValue === "stopped") {
      return;
    }

    this.engine = undefined;
    const subscribed = this.subscribed;
    this.subscribed = false;
    let failure: unknown;
    if (engine && subscribed) {
      try {
        await this.processor.unsubscribe(engine);
      } catch (error) {
        failure = error;
      }
    }
    if (engine) {
      try {
        await engine.release();
      } catch (error) {
        failure ??= error;
      }
      try {
        engine.terminate();
      } catch (error) {
        failure ??= error;
      }
    }
    this.setState("stopped");
    if (failure) {
      throw failure;
    }
  }

  private async releaseEngine(engine: WakeWordEngine | undefined, unsubscribe: boolean): Promise<void> {
    if (!engine) {
      return;
    }
    if (unsubscribe && this.subscribed) {
      try {
        await this.processor.unsubscribe(engine);
      } catch {
        // Preserve the initialization failure while still releasing the engine.
      }
    }
    try {
      await engine.release();
    } catch {
      // Preserve the initialization failure while still terminating the worker.
    }
    try {
      engine.terminate();
    } catch {
      // Preserve the initialization failure while still reporting the error state.
    }
  }

  private setState(state: WakeWordState): void {
    this.stateValue = state;
    for (const listener of this.stateListeners) {
      listener(state);
    }
  }
}

export function createPorcupineWakeWordDetector(
  accessKey: string,
  modelPublicPath = new URL("../assets/porcupine_params.pv", import.meta.url).toString()
): WakeWordDetector {
  const normalizedAccessKey = accessKey.trim();
  if (!normalizedAccessKey) {
    throw new Error("Wake word is unavailable because Picovoice access is not configured.");
  }

  const processor: WakeWordProcessor = {
    subscribe: engine => WebVoiceProcessor.subscribe(engine as PvEngine),
    unsubscribe: engine => WebVoiceProcessor.unsubscribe(engine as PvEngine)
  };
  return new WakeWordDetectorAdapter(
    async onDetected => {
      const engine = await PorcupineWorker.create(
        normalizedAccessKey,
        BuiltInKeyword.Jarvis,
        () => onDetected(),
        { publicPath: modelPublicPath });
      return engine;
    },
    processor);
}
