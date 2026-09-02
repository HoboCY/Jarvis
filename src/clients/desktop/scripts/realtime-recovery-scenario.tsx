import { createRoot, type Root } from "react-dom/client";
import type { RealtimeSession } from "@jarvis/realtime-agent";
import {
  DesktopRealtimeController,
  type DesktopRealtimeBackend,
  type DesktopRealtimeStatus
} from "../src/renderer/realtime.js";
import type { WakeWordDetector, WakeWordState } from "../src/renderer/wake-word.js";
import {
  DesktopActionRunner,
  type DesktopActionState
} from "../src/renderer/control-panel.js";
import {
  DesktopRealtimeConnectionControl,
  DesktopRealtimeRetryControls
} from "../src/renderer/realtime-retry-controls.js";

type Listener = (value?: unknown) => void;

class FakeEmitter {
  private readonly listeners = new Map<string, Set<Listener>>();

  public on(eventName: string, listener: Listener): () => void {
    const listeners = this.listeners.get(eventName) ?? new Set<Listener>();
    listeners.add(listener);
    this.listeners.set(eventName, listeners);
    return () => listeners.delete(listener);
  }

  protected emit(eventName: string, value?: unknown): void {
    for (const listener of this.listeners.get(eventName) ?? []) {
      listener(value);
    }
    if (eventName !== "*") {
      for (const listener of this.listeners.get("*") ?? []) {
        listener(value);
      }
    }
  }
}

class FakeTransport extends FakeEmitter {
  public status: "connected" | "disconnected" = "disconnected";
  public muted = true;

  public async connect(): Promise<void> {
    this.status = "connected";
    this.emit("session.created", {
      type: "session.created",
      session: { id: "scenario-external-session" }
    });
  }

  public sendEvent(): void {}

  public sendMessage(): void {}

  public addImage(): void {}

  public sendAudio(): void {}

  public updateSessionConfig(): void {}

  public close(): void {
    this.status = "disconnected";
  }

  public mute(muted: boolean): void {
    this.muted = muted;
  }

  public sendFunctionCallOutput(): void {}

  public interrupt(): void {}

  public resetHistory(): void {}

  public sendMcpResponse(): void {}

  public emitEvent(eventName: string, value?: unknown): void {
    if (eventName === "connection_change" && value === "disconnected") {
      this.status = "disconnected";
    }
    this.emit(eventName, value);
  }
}

class FakeSession extends FakeEmitter {
  public readonly transport = new FakeTransport();
  public readonly history: unknown[] = [];

  public async connect(): Promise<void> {
    await this.transport.connect();
  }

  public close(): void {
    this.transport.close();
  }

  public mute(muted: boolean): void {
    this.transport.mute(muted);
  }

  public interrupt(): void {
    this.transport.interrupt();
  }
}

function createFakeMediaStream(): {
  stream: MediaStream;
  track: { enabled: boolean; stopCalls: number };
} {
  const track = {
    enabled: false,
    stopCalls: 0,
    stop(): void {
      track.stopCalls++;
    }
  };
  return {
    stream: {
      getTracks: () => [track]
    } as unknown as MediaStream,
    track
  };
}

function createFakeWakeWordDetector(): {
  detector: WakeWordDetector;
  fail: () => void;
  startCalls: () => number;
} {
  let state: WakeWordState = "stopped";
  let startCount = 0;
  let detectedListener: (() => void) | undefined;
  let stateListener: ((nextState: WakeWordState) => void) | undefined;
  const detector: WakeWordDetector = {
    get state() {
      return state;
    },
    start: async () => {
      startCount++;
      state = "starting";
      stateListener?.(state);
      state = "listening";
      stateListener?.(state);
    },
    stop: async () => {
      state = "stopped";
      stateListener?.(state);
    },
    onDetected: listener => {
      detectedListener = listener;
      return () => {
        if (detectedListener === listener) {
          detectedListener = undefined;
        }
      };
    },
    onStateChange: listener => {
      stateListener = listener;
      return () => {
        if (stateListener === listener) {
          stateListener = undefined;
        }
      };
    }
  };
  return {
    detector,
    fail: () => {
      state = "error";
      stateListener?.(state);
    },
    startCalls: () => startCount
  };
}

type PersistenceRecoverySnapshot = Readonly<{
  status: DesktopRealtimeStatus;
  persistenceRetryReason: "event-ingest" | "session-end" | undefined;
  ingestCalls: number;
  retryCalls: number;
  retryAction: DesktopActionState | undefined;
}>;

type WakeRecoverySnapshot = Readonly<{
  status: DesktopRealtimeStatus;
  wakeState: "standby" | "awake" | "error";
  trackEnabled: boolean;
  transportCreated: boolean;
  startCalls: number;
  retryCalls: number;
  retryAction: DesktopActionState | undefined;
}>;

type TransportRecoverySnapshot = Readonly<{
  status: DesktopRealtimeStatus;
  persistenceRetryReason: "event-ingest" | "session-end" | undefined;
  wakeState: "standby" | "awake" | "error";
  trackEnabled: boolean;
  transportCreated: boolean;
  markEndedCalls: number;
  connectCalls: number;
}>;

type PersistenceRecoveryHarness = Readonly<{
  start: () => Promise<PersistenceRecoverySnapshot>;
  snapshot: () => PersistenceRecoverySnapshot;
  startWakeFailure: () => Promise<WakeRecoverySnapshot>;
  wakeSnapshot: () => WakeRecoverySnapshot;
  startTransportFailure: () => Promise<TransportRecoverySnapshot>;
  transportSnapshot: () => TransportRecoverySnapshot;
  waitForRetry: () => Promise<unknown>;
  waitForWakeRetry: () => Promise<unknown>;
  dispose: () => Promise<void>;
}>;

declare global {
  interface Window {
    __jarvisRealtimePersistenceRecovery?: PersistenceRecoveryHarness;
  }
}

function wait(milliseconds: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}

function createPersistenceRecoveryHarness(): PersistenceRecoveryHarness {
  const host = document.createElement("section");
  host.dataset.realtimeRecoveryScenario = "true";
  host.setAttribute("aria-label", "Realtime persistence recovery scenario");
  Object.assign(host.style, {
    position: "fixed",
    top: "12px",
    right: "12px",
    zIndex: "2147483647",
    display: "flex",
    gap: "8px",
    padding: "8px",
    background: "rgba(15, 23, 42, 0.96)",
    borderRadius: "8px"
  });
  document.body.append(host);
  const focusSentinel = document.createElement("button");
  focusSentinel.type = "button";
  focusSentinel.tabIndex = 0;
  focusSentinel.dataset.realtimeRecoveryTabSentinel = "true";
  focusSentinel.setAttribute("aria-hidden", "true");
  focusSentinel.setAttribute("aria-label", "Realtime recovery keyboard start");
  Object.assign(focusSentinel.style, {
    position: "absolute",
    width: "1px",
    height: "1px",
    padding: "0",
    border: "0",
    opacity: "0"
  });
  host.append(focusSentinel);
  const mount = document.createElement("div");
  host.append(mount);
  const root: Root = createRoot(mount);
  const session = new FakeSession();
  const { stream, track } = createFakeMediaStream();
  const wakeWord = createFakeWakeWordDetector();
  let controller: DesktopRealtimeController | undefined;
  let runner: DesktopActionRunner;
  let status: DesktopRealtimeStatus = "disconnected";
  let wakeState: "standby" | "awake" | "error" = "standby";
  let transportStream: MediaStream | undefined;
  let ingestCalls = 0;
  let retryCalls = 0;
  let wakeRetryCalls = 0;
  let markEndedCalls = 0;
  let connectCalls = 0;
  let startPromise: Promise<PersistenceRecoverySnapshot> | undefined;
  let retryPromise: Promise<unknown> | undefined;
  let wakeRetryPromise: Promise<unknown> | undefined;
  let markEndedResolve: (() => void) | undefined;
  const markEndedCompletion = new Promise<void>(resolve => {
    markEndedResolve = resolve;
  });

  const render = (): void => {
    root.render(
      <>
        <DesktopRealtimeRetryControls
        status={status}
        wakeState={wakeState}
        hasController={controller !== undefined}
        persistenceRetryReason={controller?.persistenceRetryReason}
        persistenceAction={runner?.get("realtime-retry-persistence")}
        onRetryPersistence={() => {
          retryCalls++;
          retryPromise = runner.run(
            "realtime-retry-persistence",
            () => controller!.retryPersistence());
          void retryPromise.catch(() => undefined);
        }}
        wakeAction={runner?.get("realtime-retry-wake")}
        onRetryWake={() => {
          wakeRetryCalls++;
          wakeRetryPromise = runner.run(
            "realtime-retry-wake",
            () => controller!.retryWakeWord());
          void wakeRetryPromise.catch(() => undefined);
        }}
        />
        <DesktopRealtimeConnectionControl
          status={status}
          connectAction={runner?.get("realtime-connect")}
          disconnectAction={runner?.get("realtime-disconnect")}
          onConnect={() => { connectCalls++; }}
          onDisconnect={() => undefined}
        />
      </>
    );
  };

  runner = new DesktopActionRunner({
    onStateChange: state => {
      if (state.key === "realtime-retry-persistence" || state.key === "realtime-retry-wake") {
        render();
      }
    }
  });

  const snapshot = (): PersistenceRecoverySnapshot => ({
    status,
    persistenceRetryReason: controller?.persistenceRetryReason,
    ingestCalls,
    retryCalls,
    retryAction: runner.get("realtime-retry-persistence")
  });

  const wakeSnapshot = (): WakeRecoverySnapshot => ({
    status,
    wakeState,
    trackEnabled: track.enabled,
    transportCreated: transportStream === stream,
    startCalls: wakeWord.startCalls(),
    retryCalls: wakeRetryCalls,
    retryAction: runner.get("realtime-retry-wake")
  });

  const start = (): Promise<PersistenceRecoverySnapshot> => {
    if (startPromise) {
      return startPromise;
    }

    startPromise = (async () => {
      let failIngest = true;
      const backend: DesktopRealtimeBackend = {
        markConnected: async () => undefined,
        markEnded: async () => {
          markEndedCalls++;
          markEndedResolve?.();
        },
        ingest: async () => {
          ingestCalls++;
          if (failIngest) {
            failIngest = false;
            throw new Error("scenario persistence backend unavailable");
          }
          return { accepted: true };
        }
      };
      controller = new DesktopRealtimeController(
        "0198b0a1-0000-7000-8000-000000000301",
        backend,
        nextStatus => {
          status = nextStatus;
          render();
        },
        undefined,
        (_agent, _options) => session as unknown as RealtimeSession,
        mediaStream => {
          transportStream = mediaStream;
          return session.transport as never;
        }
      );
      controller.setWakeWordDetector(wakeWord.detector, nextWakeState => {
        wakeState = nextWakeState;
        render();
      });
      render();
      await controller.connect({
        realtimeSessionId: "0198b0a1-0000-7000-8000-000000000302",
        clientSecret: "scenario-client-secret",
        model: "scenario-model",
        voice: "scenario-voice",
        instructions: "Scenario-only realtime persistence test.",
        mediaStream: stream
      });
      session.transport.emitEvent("output_text_delta", {
        itemId: "scenario-item",
        delta: "scenario output",
        responseId: "scenario-response"
      });
      await Promise.resolve();
      if (await controller.flushPendingPersistence()) {
        throw new Error("The persistence fixture did not produce a failure.");
      }
      await wait(0);
      return snapshot();
    })();
    return startPromise;
  };

  const startWakeFailure = async (): Promise<WakeRecoverySnapshot> => {
    await start();
    wakeWord.fail();
    await wait(0);
    return wakeSnapshot();
  };

  const transportSnapshot = (): TransportRecoverySnapshot => ({
    status,
    persistenceRetryReason: controller?.persistenceRetryReason,
    wakeState,
    trackEnabled: track.enabled,
    transportCreated: transportStream === stream,
    markEndedCalls,
    connectCalls
  });

  const startTransportFailure = async (): Promise<TransportRecoverySnapshot> => {
    await start();
    session.transport.emitEvent("connection_change", "disconnected");
    await markEndedCompletion;
    await wait(0);
    return transportSnapshot();
  };

  const dispose = async (): Promise<void> => {
    if (controller) {
      await controller.disconnect("scenario-complete");
    }
    root.unmount();
    host.remove();
    delete window.__jarvisRealtimePersistenceRecovery;
  };

  render();
  const harness: PersistenceRecoveryHarness = {
    start,
    snapshot,
    startWakeFailure,
    wakeSnapshot,
    startTransportFailure,
    transportSnapshot,
    waitForRetry: () => retryPromise ?? Promise.resolve(),
    waitForWakeRetry: () => wakeRetryPromise ?? Promise.resolve(),
    dispose
  };
  window.__jarvisRealtimePersistenceRecovery = harness;
  return harness;
}

createPersistenceRecoveryHarness();
