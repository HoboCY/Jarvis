import { strict as assert } from "node:assert";
import { test } from "node:test";
import type { NormalizedRealtimeEvent, RealtimeSession } from "@jarvis/realtime-agent";
import { ensureConversation } from "./conversation-flow.js";
import { canSendRealtimeText, RealtimeConnectGate } from "./realtime-connect-flow.js";
import {
  DesktopRealtimeController,
  mapRealtimeCancelResponse,
  mapRealtimeTaskStatusResponse
} from "./realtime.js";
import {
  IpcWakeWordDetector,
  builtInWakeWord,
  type WakeWordBridge,
  type WakeWordDetector,
  type WakeWordState
} from "./wake-word.js";

type Listener = (...args: never[]) => void;

test("ensureConversation creates once and lets the first connect continue", async () => {
  const created = { id: "conversation-created" };
  let createCalls = 0;

  const result = await ensureConversation(undefined, async () => {
    createCalls++;
    return created;
  });

  assert.equal(result, created);
  assert.equal(createCalls, 1);
});

test("Realtime connect gate collapses concurrent connect attempts into one session bootstrap", async () => {
  const gate = new RealtimeConnectGate();
  let release: (() => void) | undefined;
  let connectCalls = 0;
  const first = gate.run(async () => {
    connectCalls++;
    await new Promise<void>(resolve => {
      release = resolve;
    });
  });
  const second = gate.run(async () => {
    connectCalls++;
  });

  await Promise.resolve();

  assert.equal(first, second);
  assert.equal(connectCalls, 1);
  assert.equal(gate.isRunning, true);

  release?.();
  await first;

  assert.equal(gate.isRunning, false);
});

test("typed Realtime input is accepted only by one fully connected session", () => {
  assert.equal(canSendRealtimeText("disconnected", false), false);
  assert.equal(canSendRealtimeText("connecting", true), false);
  assert.equal(canSendRealtimeText("degraded", false), false);
  assert.equal(canSendRealtimeText("connected", true), false);
  assert.equal(canSendRealtimeText("connected", false), true);
});

test("maps full backend task responses to the strict Realtime status contract", () => {
  assert.deepEqual(
    mapRealtimeTaskStatusResponse({
      id: "0198b0a1-0000-7000-8000-000000000001",
      status: "waitingForApproval",
      progressSummary: "等待用户确认",
      resultSummary: "must not leak",
      errorMessage: "must not leak"
    }),
    {
      taskId: "0198b0a1-0000-7000-8000-000000000001",
      status: "waitingForApproval",
      progressSummary: "等待用户确认",
      requiresUserAction: true
    }
  );
  assert.deepEqual(
    mapRealtimeTaskStatusResponse({
      taskId: "0198b0a1-0000-7000-8000-000000000002",
      status: "running",
      progressSummary: null
    }),
    {
      taskId: "0198b0a1-0000-7000-8000-000000000002",
      status: "running",
      progressSummary: null,
      requiresUserAction: false
    }
  );
});

test("maps cancellation responses without leaking the backend task id", () => {
  assert.deepEqual(
    mapRealtimeCancelResponse({
      taskId: "0198b0a1-0000-7000-8000-000000000003",
      accepted: true,
      status: "cancellationRequested"
    }),
    { accepted: true, status: "cancellationRequested" }
  );
});

test("rejects malformed backend responses before they reach Realtime tools", () => {
  assert.throws(
    () => mapRealtimeTaskStatusResponse({ status: "running", progressSummary: null }),
    /Invalid Realtime task status response/
  );
  assert.throws(
    () => mapRealtimeTaskStatusResponse({ id: "0198b0a1-0000-7000-8000-000000000004", status: "running", progressSummary: 1 }),
    /Invalid Realtime task status response/
  );
  assert.throws(
    () => mapRealtimeCancelResponse({ accepted: "true", status: "cancelled" }),
    /Invalid Realtime cancellation response/
  );
});

class FakeTransport {
  public readonly sentEvents: unknown[] = [];
  private readonly listeners = new Map<string, Listener[]>();

  public on(event: string, listener: Listener): this {
    this.listeners.set(event, [...(this.listeners.get(event) ?? []), listener]);
    return this;
  }

  public emit(event: string, ...args: unknown[]): void {
    for (const listener of this.listeners.get(event) ?? []) {
      listener(...(args as never[]));
    }
  }

  public sendEvent(event: unknown): void {
    this.sentEvents.push(event);
  }
}

class FakeSession {
  public readonly transport = new FakeTransport();
  public readonly calls: string[] = [];
  public connectInput: unknown;
  public history: unknown[] = [];
  private readonly listeners = new Map<string, Listener[]>();

  public constructor(
    private readonly emitSessionCreated = true,
    private readonly connectError?: Error,
    private readonly deferSessionCreated = false
  ) {}

  public async connect(input?: unknown): Promise<void> {
    this.connectInput = input;
    if (this.connectError) {
      throw this.connectError;
    }

    if (this.emitSessionCreated) {
      const emitCreated = () => {
        this.transport.emit("*", { type: "session.created", session: { id: "external-scripted" } });
      };
      if (this.deferSessionCreated) {
        await Promise.resolve();
        setImmediate(emitCreated);
      } else {
        emitCreated();
      }
    }
  }

  public on(event: string, listener: Listener): this {
    this.listeners.set(event, [...(this.listeners.get(event) ?? []), listener]);
    return this;
  }

  public emit(event: string, ...args: unknown[]): void {
    for (const listener of this.listeners.get(event) ?? []) {
      listener(...(args as never[]));
    }
  }

  public interrupt(): void {
    this.calls.push("interrupt");
  }

  public close(): void {
    this.calls.push("close");
  }

  public mute(muted = true): void {
    this.calls.push(`mute:${muted}`);
  }
}

function fakeMediaStream(): { stream: MediaStream; track: MediaStreamTrack; stopCalls: () => number } {
  let enabled = true;
  let stopped = false;
  let stopCalls = 0;
  const track = {
    get enabled() {
      return enabled && !stopped;
    },
    set enabled(value: boolean) {
      enabled = value;
    },
    stop: () => {
      stopCalls++;
      stopped = true;
    }
  } as unknown as MediaStreamTrack;
  const stream = {
    getTracks: () => [track]
  } as unknown as MediaStream;
  return { stream, track, stopCalls: () => stopCalls };
}

function fakeWakeWordDetector(): {
  detector: WakeWordDetector;
  detect: () => void;
  fail: () => void;
  failNextStart: () => void;
  started: boolean;
  startCalls: () => number;
  stopped: boolean;
} {
  let onDetected: (() => void) | undefined;
  let onStateChange: ((state: WakeWordState) => void) | undefined;
  let state: WakeWordState = "stopped";
  let started = false;
  let startCalls = 0;
  let shouldFailNextStart = false;
  let stopped = false;
  const detector: WakeWordDetector = {
    get state() {
      return state;
    },
    start: async () => {
      startCalls++;
      if (shouldFailNextStart) {
        shouldFailNextStart = false;
        state = "error";
        throw new Error("native detector unavailable");
      }
      state = "starting";
      started = true;
      state = "listening";
      onStateChange?.("listening");
    },
    stop: async () => {
      stopped = true;
      state = "stopped";
      onStateChange?.("stopped");
    },
    onDetected: listener => {
      onDetected = listener;
      return () => {
        onDetected = undefined;
      };
    },
    onStateChange: listener => {
      onStateChange = listener;
      return () => {
        onStateChange = undefined;
      };
    }
  };
  return {
    detector,
    detect: () => onDetected?.(),
    fail: () => {
      state = "error";
      onStateChange?.("error");
    },
    failNextStart: () => {
      shouldFailNextStart = true;
    },
    get started() {
      return started;
    },
    startCalls: () => startCalls,
    get stopped() {
      return stopped;
    }
  };
}

test("Desktop controller keeps application-owned realtime audio muted until wake and remutes after one turn", async () => {
  const fakeSession = new FakeSession();
  const { stream, track } = fakeMediaStream();
  const wakeWord = fakeWakeWordDetector();
  let transportCreated = false;
  const controller = new DesktopRealtimeController(
    "conversation-wake-word",
    {
      markConnected: async () => undefined,
      markEnded: async () => undefined,
      ingest: async () => undefined
    },
    () => undefined,
    () => 0,
    (_agent, options) => {
      transportCreated = typeof options.transport !== "string";
      return fakeSession as unknown as RealtimeSession;
    },
    mediaStream => {
      assert.equal(mediaStream, stream);
      assert.equal(track.enabled, false);
      return new FakeTransport() as never;
    }
  );
  controller.setWakeWordDetector(wakeWord.detector);

  try {
    await controller.connect({
      realtimeSessionId: "00000000-0000-0000-0000-000000000081",
      clientSecret: "ek_scripted",
      model: "model",
      voice: "voice",
      instructions: "server context",
      mediaStream: stream
    });
    assert.equal(transportCreated, true);
    assert.equal(track.enabled, false);
    assert.equal(wakeWord.started, true);

    wakeWord.detect();
    assert.equal(track.enabled, true);
    assert.equal(controller.wakeState, "awake");
    fakeSession.transport.emit("turn_done", { response: { output: [] } });
    assert.equal(track.enabled, false);
    assert.equal(controller.wakeState, "standby");
  } finally {
    await controller.disconnect();
  }

  assert.equal(wakeWord.stopped, true);
  assert.equal(track.enabled, false);
});

test("Desktop controller accepts one detection per awake turn and rearms after completion", async () => {
  const fakeSession = new FakeSession();
  const { stream, track } = fakeMediaStream();
  const wakeWord = fakeWakeWordDetector();
  const wakeStates: string[] = [];
  const controller = new DesktopRealtimeController(
    "conversation-single-turn",
    {
      markConnected: async () => undefined,
      markEnded: async () => undefined,
      ingest: async () => undefined
    },
    () => undefined,
    () => 0,
    () => fakeSession as unknown as RealtimeSession,
    () => new FakeTransport() as never
  );
  controller.setWakeWordDetector(wakeWord.detector, state => wakeStates.push(state));

  try {
    await controller.connect({
      realtimeSessionId: "00000000-0000-0000-0000-000000000085",
      clientSecret: "ek_scripted",
      model: "model",
      voice: "voice",
      instructions: "server context",
      mediaStream: stream
    });

    wakeWord.detect();
    wakeWord.detect();
    fakeSession.transport.emit("turn_done", { response: { output: [] } });
    fakeSession.transport.emit("turn_done", { response: { output: [] } });

    assert.deepEqual(wakeStates, ["standby", "awake", "standby"]);
    assert.equal(track.enabled, false);

    wakeWord.detect();
    assert.equal(controller.wakeState, "awake");
    assert.equal(track.enabled, true);
  } finally {
    await controller.disconnect();
  }
});

test("Desktop controller ignores a late completion from the previous wake response", async () => {
  const fakeSession = new FakeSession();
  const { stream, track } = fakeMediaStream();
  const wakeWord = fakeWakeWordDetector();
  const controller = new DesktopRealtimeController(
    "conversation-late-response-done",
    {
      markConnected: async () => undefined,
      markEnded: async () => undefined,
      ingest: async () => undefined
    },
    () => undefined,
    () => 0,
    () => fakeSession as unknown as RealtimeSession,
    () => new FakeTransport() as never
  );
  controller.setWakeWordDetector(wakeWord.detector);

  try {
    await controller.connect({
      realtimeSessionId: "00000000-0000-0000-0000-000000000090",
      clientSecret: "ek_scripted",
      model: "model",
      voice: "voice",
      instructions: "server context",
      mediaStream: stream
    });

    wakeWord.detect();
    fakeSession.transport.emit("turn_started", {
      providerData: { response: { id: "response-1" } }
    });
    fakeSession.transport.emit("turn_done", { response: { id: "response-1", output: [] } });
    assert.equal(controller.wakeState, "standby");

    wakeWord.detect();
    fakeSession.transport.emit("turn_started", {
      providerData: { response: { id: "response-2" } }
    });
    fakeSession.transport.emit("turn_done", { response: { id: "response-1", output: [] } });
    assert.equal(controller.wakeState, "awake");
    assert.equal(track.enabled, true);

    fakeSession.transport.emit("turn_done", { response: { id: "response-2", output: [] } });
    assert.equal(controller.wakeState, "standby");
    assert.equal(track.enabled, false);
  } finally {
    await controller.disconnect();
  }
});

test("Desktop controller ignores a late completion after interrupting the previous wake response", async () => {
  const fakeSession = new FakeSession();
  const { stream, track } = fakeMediaStream();
  const wakeWord = fakeWakeWordDetector();
  const controller = new DesktopRealtimeController(
    "conversation-late-response-interrupt",
    {
      markConnected: async () => undefined,
      markEnded: async () => undefined,
      ingest: async () => undefined
    },
    () => undefined,
    () => 0,
    () => fakeSession as unknown as RealtimeSession,
    () => new FakeTransport() as never
  );
  controller.setWakeWordDetector(wakeWord.detector);

  try {
    await controller.connect({
      realtimeSessionId: "00000000-0000-0000-0000-000000000091",
      clientSecret: "ek_scripted",
      model: "model",
      voice: "voice",
      instructions: "server context",
      mediaStream: stream
    });

    wakeWord.detect();
    fakeSession.transport.emit("turn_started", {
      providerData: { response: { id: "response-interrupted" } }
    });
    controller.interrupt();
    assert.equal(controller.wakeState, "standby");

    wakeWord.detect();
    fakeSession.transport.emit("turn_started", {
      providerData: { response: { id: "response-next" } }
    });
    fakeSession.transport.emit("turn_done", {
      response: { id: "response-interrupted", output: [] }
    });
    assert.equal(controller.wakeState, "awake");
    assert.equal(track.enabled, true);

    fakeSession.transport.emit("turn_done", { response: { id: "response-next", output: [] } });
    assert.equal(controller.wakeState, "standby");
    assert.equal(track.enabled, false);
  } finally {
    await controller.disconnect();
  }
});

test("Desktop controller fails closed when an awake turn is explicitly interrupted", async () => {
  const fakeSession = new FakeSession();
  const { stream, track } = fakeMediaStream();
  const wakeWord = fakeWakeWordDetector();
  const controller = new DesktopRealtimeController(
    "conversation-wake-word-interrupt",
    {
      markConnected: async () => undefined,
      markEnded: async () => undefined,
      ingest: async () => undefined
    },
    () => undefined,
    () => 0,
    () => fakeSession as unknown as RealtimeSession,
    () => new FakeTransport() as never
  );
  controller.setWakeWordDetector(wakeWord.detector);

  try {
    await controller.connect({
      realtimeSessionId: "00000000-0000-0000-0000-000000000083",
      clientSecret: "ek_scripted",
      model: "model",
      voice: "voice",
      instructions: "server context",
      mediaStream: stream
    });
    wakeWord.detect();
    assert.equal(track.enabled, true);
    assert.equal(controller.wakeState, "awake");

    controller.interrupt();

    assert.equal(track.enabled, false);
    assert.equal(controller.wakeState, "standby");
    assert.equal(fakeSession.calls.at(-1), "interrupt");
    assert.equal(fakeSession.calls.at(-2), "mute:true");
  } finally {
    await controller.disconnect();
  }
});

test("Desktop controller fails closed on both realtime audio interruption event paths", async () => {
  const fakeSession = new FakeSession();
  const { stream, track } = fakeMediaStream();
  const wakeWord = fakeWakeWordDetector();
  const controller = new DesktopRealtimeController(
    "conversation-wake-word-audio-interrupted",
    {
      markConnected: async () => undefined,
      markEnded: async () => undefined,
      ingest: async () => undefined
    },
    () => undefined,
    () => 0,
    () => fakeSession as unknown as RealtimeSession,
    () => new FakeTransport() as never
  );
  controller.setWakeWordDetector(wakeWord.detector);

  try {
    await controller.connect({
      realtimeSessionId: "00000000-0000-0000-0000-000000000084",
      clientSecret: "ek_scripted",
      model: "model",
      voice: "voice",
      instructions: "server context",
      mediaStream: stream
    });

    wakeWord.detect();
    fakeSession.transport.emit("audio_interrupted");
    assert.equal(track.enabled, false);
    assert.equal(controller.wakeState, "standby");

    wakeWord.detect();
    fakeSession.emit("audio_interrupted");
    assert.equal(track.enabled, false);
    assert.equal(controller.wakeState, "standby");
  } finally {
    await controller.disconnect();
  }
});

test("Desktop controller exposes a fatal wake error and mutes the active voice turn", async () => {
  const fakeSession = new FakeSession();
  const { stream, track } = fakeMediaStream();
  const wakeWord = fakeWakeWordDetector();
  const controller = new DesktopRealtimeController(
    "conversation-wake-word-error",
    {
      markConnected: async () => undefined,
      markEnded: async () => undefined,
      ingest: async () => undefined
    },
    () => undefined,
    () => 0,
    () => fakeSession as unknown as RealtimeSession,
    () => new FakeTransport() as never
  );
  controller.setWakeWordDetector(wakeWord.detector);

  try {
    await controller.connect({
      realtimeSessionId: "00000000-0000-0000-0000-000000000086",
      clientSecret: "ek_scripted",
      model: "model",
      voice: "voice",
      instructions: "server context",
      mediaStream: stream
    });
    wakeWord.detect();
    assert.equal(controller.wakeState, "awake");

    wakeWord.fail();

    assert.equal(controller.wakeState, "error");
    assert.equal(track.enabled, false);
  } finally {
    await controller.disconnect();
  }
});

test("Desktop controller can explicitly retry a failed wake detector", async () => {
  const fakeSession = new FakeSession();
  const { stream, track } = fakeMediaStream();
  const wakeWord = fakeWakeWordDetector();
  const controller = new DesktopRealtimeController(
    "conversation-wake-word-retry",
    {
      markConnected: async () => undefined,
      markEnded: async () => undefined,
      ingest: async () => undefined
    },
    () => undefined,
    () => 0,
    () => fakeSession as unknown as RealtimeSession,
    () => new FakeTransport() as never
  );
  controller.setWakeWordDetector(wakeWord.detector);

  try {
    await controller.connect({
      realtimeSessionId: "00000000-0000-0000-0000-000000000088",
      clientSecret: "ek_scripted",
      model: "model",
      voice: "voice",
      instructions: "server context",
      mediaStream: stream
    });
    wakeWord.detect();
    wakeWord.fail();
    assert.equal(controller.wakeState, "error");

    await controller.retryWakeWord();

    assert.equal(wakeWord.startCalls(), 2);
    assert.equal(controller.wakeState, "standby");
    assert.equal(track.enabled, false);
    wakeWord.detect();
    assert.equal(controller.wakeState, "awake");
  } finally {
    await controller.disconnect();
  }
});

test("Desktop controller keeps wake audio closed when an explicit retry fails", async () => {
  const fakeSession = new FakeSession();
  const { stream, track } = fakeMediaStream();
  const wakeWord = fakeWakeWordDetector();
  const controller = new DesktopRealtimeController(
    "conversation-wake-word-retry-failure",
    {
      markConnected: async () => undefined,
      markEnded: async () => undefined,
      ingest: async () => undefined
    },
    () => undefined,
    () => 0,
    () => fakeSession as unknown as RealtimeSession,
    () => new FakeTransport() as never
  );
  controller.setWakeWordDetector(wakeWord.detector);

  try {
    await controller.connect({
      realtimeSessionId: "00000000-0000-0000-0000-000000000089",
      clientSecret: "ek_scripted",
      model: "model",
      voice: "voice",
      instructions: "server context",
      mediaStream: stream
    });
    wakeWord.fail();
    wakeWord.failNextStart();

    await assert.rejects(
      controller.retryWakeWord(),
      /本地中文唤醒词检测不可用/
    );

    assert.equal(wakeWord.startCalls(), 2);
    assert.equal(controller.wakeState, "error");
    assert.equal(track.enabled, false);
  } finally {
    await controller.disconnect();
  }
});

test("Desktop controller does not accept a stale detector retry after a fatal bridge error", async () => {
  const fakeSession = new FakeSession();
  const { stream, track } = fakeMediaStream();
  let startCalls = 0;
  let errorListener: ((message: string) => void) | undefined;
  let resolvePendingStart: (() => void) | undefined;
  const bridge: WakeWordBridge = {
    startWakeWordDetection: () => {
      startCalls++;
      if (startCalls === 1) {
        return Promise.resolve();
      }
      return new Promise<void>(resolve => {
        resolvePendingStart = resolve;
      });
    },
    stopWakeWordDetection: async () => undefined,
    onWakeWordDetected: () => () => undefined,
    onWakeWordError: listener => {
      errorListener = listener;
      return () => {
        errorListener = undefined;
      };
    }
  };
  const detector = new IpcWakeWordDetector(bridge, builtInWakeWord);
  const controller = new DesktopRealtimeController(
    "conversation-stale-detector-retry",
    {
      markConnected: async () => undefined,
      markEnded: async () => undefined,
      ingest: async () => undefined
    },
    () => undefined,
    () => 0,
    () => fakeSession as unknown as RealtimeSession,
    () => new FakeTransport() as never
  );
  controller.setWakeWordDetector(detector);

  try {
    await controller.connect({
      realtimeSessionId: "00000000-0000-0000-0000-000000000090",
      clientSecret: "ek_scripted",
      model: "model",
      voice: "voice",
      instructions: "server context",
      mediaStream: stream
    });
    errorListener?.("native detector failed");
    assert.equal(controller.wakeState, "error");

    const staleRetry = controller.retryWakeWord();
    assert.equal(startCalls, 2);
    errorListener?.("native detector failed during retry");
    resolvePendingStart?.();

    await assert.rejects(staleRetry, /本地中文唤醒词检测不可用/);
    assert.equal(controller.wakeState, "error");
    assert.equal(track.enabled, false);

    const explicitRetry = controller.retryWakeWord();
    assert.equal(startCalls, 3);
    resolvePendingStart?.();
    await explicitRetry;
    assert.equal(controller.wakeState, "standby");
  } finally {
    await controller.disconnect();
  }
});

test("Desktop controller releases owned audio after a failed connect", async () => {
  const failedSession = new FakeSession(false, new Error("network unavailable"));
  const { stream, stopCalls } = fakeMediaStream();
  const wakeWord = fakeWakeWordDetector();
  const controller = new DesktopRealtimeController(
    "conversation-wake-word-failure",
    {
      markConnected: async () => undefined,
      markEnded: async () => undefined,
      ingest: async () => undefined
    },
    () => undefined,
    () => 0,
    () => failedSession as unknown as RealtimeSession,
    () => new FakeTransport() as never
  );
  controller.setWakeWordDetector(wakeWord.detector);

  await assert.rejects(
    controller.connect({
      realtimeSessionId: "00000000-0000-0000-0000-000000000082",
      clientSecret: "ek_scripted",
      model: "model",
      voice: "voice",
      instructions: "server context",
      mediaStream: stream
    }),
    /network unavailable/
  );
  assert.equal(stopCalls() > 0, true);
});

test("Desktop controller uses the injected session and preserves typed persistence order", async () => {
  const fakeSession = new FakeSession();
  const lifecycle: string[] = [];
  let agentInstructions = "";
  const controller = new DesktopRealtimeController(
    "conversation-1",
    {
      markConnected: async input => {
        lifecycle.push(`connected:${input.externalSessionId}`);
      },
      markEnded: async input => {
        lifecycle.push(`ended:${input.status}`);
      },
      ingest: async () => undefined
    },
    () => undefined,
    () => 0,
    agent => {
      agentInstructions = typeof agent.instructions === "string" ? agent.instructions : "";
      return fakeSession as unknown as RealtimeSession;
    }
  );

  try {
    await controller.connect({
      realtimeSessionId: "00000000-0000-0000-0000-000000000001",
      clientSecret: "ek_scripted",
      webRtcUrl: "https://example.openai.azure.com/openai/v1/realtime/calls",
      model: "model",
      voice: "voice",
      instructions: "server context with preferences"
    });
    assert.equal(controller.status, "connected");
    assert.equal(agentInstructions, "server context with preferences");
    assert.deepEqual(fakeSession.connectInput, {
      apiKey: "ek_scripted",
      model: "model",
      url: "https://example.openai.azure.com/openai/v1/realtime/calls"
    });
    assert.deepEqual(lifecycle, ["connected:external-scripted"]);

    await controller.sendTyped("继续", async text => {
      lifecycle.push(`persist:${text}`);
    });
    assert.deepEqual(lifecycle, ["connected:external-scripted", "persist:继续"]);
    assert.deepEqual(fakeSession.calls, ["interrupt"]);
    assert.equal(fakeSession.transport.sentEvents.length, 2);
    assert.deepEqual(fakeSession.transport.sentEvents[1], {
      type: "response.create",
      response: { output_modalities: ["text"] }
    });
  } finally {
    await controller.disconnect();
  }

  assert.deepEqual(fakeSession.calls, ["interrupt", "close"]);
  assert.deepEqual(lifecycle, [
    "connected:external-scripted",
    "persist:继续",
    "ended:disconnected"
  ]);
});

test("Desktop controller rejects a connection without the actual WebRTC session id", async () => {
  const fakeSession = new FakeSession(false);
  let connectedExternalSessionId = "";
  const controller = new DesktopRealtimeController(
    "conversation-1",
    {
      markConnected: async input => {
        connectedExternalSessionId = input.externalSessionId;
      },
      markEnded: async () => undefined,
      ingest: async () => undefined
    },
    () => undefined,
    () => 0,
    () => fakeSession as unknown as RealtimeSession
  );

  await assert.rejects(
    controller.connect({
      realtimeSessionId: "00000000-0000-0000-0000-000000000002",
      clientSecret: "ek_scripted",
      model: "model",
      voice: "voice",
      instructions: "server context"
    }),
    /actual WebRTC session id/
  );
  assert.equal(connectedExternalSessionId, "");
});

test("transport disconnect fails closed synchronously before asynchronous cleanup", async () => {
  const fakeSession = new FakeSession();
  const { stream, track } = fakeMediaStream();
  const wakeWord = fakeWakeWordDetector();
  const controller = new DesktopRealtimeController(
    "conversation-transport-disconnect",
    {
      markConnected: async () => undefined,
      markEnded: async () => undefined,
      ingest: async () => undefined
    },
    () => undefined,
    () => 0,
    () => fakeSession as unknown as RealtimeSession,
    () => new FakeTransport() as never
  );
  controller.setWakeWordDetector(wakeWord.detector);

  try {
    await controller.connect({
      realtimeSessionId: "00000000-0000-0000-0000-000000000092",
      clientSecret: "ek_scripted",
      model: "model",
      voice: "voice",
      instructions: "server context",
      mediaStream: stream
    });
    wakeWord.detect();
    assert.equal(controller.wakeState, "awake");

    fakeSession.transport.emit("connection_change", "disconnected");
    const stateAtDisconnect = controller.wakeState;
    const trackAtDisconnect = track.enabled;
    await new Promise<void>(resolve => setImmediate(resolve));

    assert.equal(stateAtDisconnect, "standby");
    assert.equal(trackAtDisconnect, false);
    assert.equal(controller.status, "degraded");
  } finally {
    await controller.disconnect();
  }
});

test("transport error fails closed synchronously before reporting degraded", async () => {
  const fakeSession = new FakeSession();
  const { stream, track } = fakeMediaStream();
  const wakeWord = fakeWakeWordDetector();
  const controller = new DesktopRealtimeController(
    "conversation-transport-error",
    {
      markConnected: async () => undefined,
      markEnded: async () => undefined,
      ingest: async () => undefined
    },
    () => undefined,
    () => 0,
    () => fakeSession as unknown as RealtimeSession,
    () => new FakeTransport() as never
  );
  controller.setWakeWordDetector(wakeWord.detector);

  try {
    await controller.connect({
      realtimeSessionId: "00000000-0000-0000-0000-000000000093",
      clientSecret: "ek_scripted",
      model: "model",
      voice: "voice",
      instructions: "server context",
      mediaStream: stream
    });
    wakeWord.detect();
    assert.equal(controller.wakeState, "awake");

    fakeSession.transport.emit("error", { type: "error", error: new Error("provider unavailable") });
    const stateAtError = controller.wakeState;
    const trackAtError = track.enabled;

    assert.equal(stateAtError, "standby");
    assert.equal(trackAtError, false);
    assert.equal(controller.status, "degraded");
  } finally {
    await controller.disconnect();
  }
});

test("Desktop controller waits for session.created emitted after connect resolves", async () => {
  const fakeSession = new FakeSession(true, undefined, true);
  let connectedExternalSessionId = "";
  const controller = new DesktopRealtimeController(
    "conversation-deferred-session-id",
    {
      markConnected: async input => {
        connectedExternalSessionId = input.externalSessionId;
      },
      markEnded: async () => undefined,
      ingest: async () => undefined
    },
    () => undefined,
    () => 0,
    () => fakeSession as unknown as RealtimeSession
  );

  try {
    await controller.connect({
      realtimeSessionId: "00000000-0000-0000-0000-000000000003",
      clientSecret: "ek_scripted",
      model: "model",
      voice: "voice",
      instructions: "server context"
    });
    assert.equal(connectedExternalSessionId, "external-scripted");
  } finally {
    await controller.disconnect();
  }
});

test("rotation marks the replacement connected before closing the old session", async () => {
  const first = new FakeSession();
  const second = new FakeSession();
  const sessions = [first, second];
  const lifecycle: string[] = [];
  let sessionIndex = 0;
  let now = 0;
  const controller = new DesktopRealtimeController(
    "conversation-rotation",
    {
      markConnected: async input => lifecycle.push(`connected:${input.sessionId}`),
      markEnded: async input => lifecycle.push(`ended:${input.sessionId}:${input.status}`),
      ingest: async () => undefined
    },
    () => undefined,
    () => now,
    () => sessions[sessionIndex++] as unknown as RealtimeSession
  );

  try {
    await controller.connect({
      realtimeSessionId: "00000000-0000-0000-0000-000000000011",
      clientSecret: "ek_scripted",
      model: "model",
      voice: "voice",
      instructions: "server context"
    });
    controller.setRotationProvider(async () => ({
      realtimeSessionId: "00000000-0000-0000-0000-000000000012",
      clientSecret: "ek_scripted-2",
      model: "model",
      voice: "voice",
      instructions: "server context after rotation"
    }));
    now = 50 * 60 * 1000;

    await controller.rotateIfIdle();

    // A late disconnect from the old transport must not tear down the new one.
    first.transport.emit("connection_change", "disconnected");
    await new Promise(resolve => setImmediate(resolve));

    assert.deepEqual(lifecycle, [
      "connected:00000000-0000-0000-0000-000000000011",
      "connected:00000000-0000-0000-0000-000000000012",
      "ended:00000000-0000-0000-0000-000000000011:rotated"
    ]);
    assert.deepEqual(first.calls, ["close"]);
    assert.equal(controller.realtimeSessionId, "00000000-0000-0000-0000-000000000012");
  } finally {
    await controller.disconnect();
  }
});

test("failed rotation keeps the old session open and does not end it", async () => {
  const first = new FakeSession();
  const failedReplacement = new FakeSession(false, new Error("network unavailable"));
  const sessions = [first, failedReplacement];
  const lifecycle: string[] = [];
  let sessionIndex = 0;
  let now = 0;
  const controller = new DesktopRealtimeController(
    "conversation-rotation-failure",
    {
      markConnected: async input => lifecycle.push(`connected:${input.sessionId}`),
      markEnded: async input => lifecycle.push(`ended:${input.sessionId}:${input.status}`),
      ingest: async () => undefined
    },
    () => undefined,
    () => now,
    () => sessions[sessionIndex++] as unknown as RealtimeSession
  );

  try {
    await controller.connect({
      realtimeSessionId: "00000000-0000-0000-0000-000000000021",
      clientSecret: "ek_scripted",
      model: "model",
      voice: "voice",
      instructions: "server context"
    });
    controller.setRotationProvider(async () => ({
      realtimeSessionId: "00000000-0000-0000-0000-000000000022",
      clientSecret: "ek_scripted-2",
      model: "model",
      voice: "voice",
      instructions: "server context after rotation"
    }));
    now = 50 * 60 * 1000;

    await controller.rotateIfIdle();

    assert.equal(controller.realtimeSessionId, "00000000-0000-0000-0000-000000000021");
    assert.equal(controller.status, "connected");
    assert.deepEqual(first.calls, []);
    assert.deepEqual(lifecycle, [
      "connected:00000000-0000-0000-0000-000000000021",
      "ended:00000000-0000-0000-0000-000000000022:failed"
    ]);
    assert.equal(lifecycle.some(item => item.includes("00000000-0000-0000-0000-000000000021") && item.includes("ended")), false);
  } finally {
    await controller.disconnect();
  }
});

test("rotation secret/bootstrap failure keeps the old session connected", async () => {
  const first = new FakeSession();
  let now = 0;
  const lifecycle: string[] = [];
  const controller = new DesktopRealtimeController(
    "conversation-bootstrap-failure",
    {
      markConnected: async input => lifecycle.push(`connected:${input.sessionId}`),
      markEnded: async input => lifecycle.push(`ended:${input.sessionId}:${input.status}`),
      ingest: async () => undefined
    },
    () => undefined,
    () => now,
    () => first as unknown as RealtimeSession,
    () => new FakeTransport() as never
  );

  try {
    await controller.connect({
      realtimeSessionId: "00000000-0000-0000-0000-000000000061",
      clientSecret: "ek_scripted",
      model: "model",
      voice: "voice",
      instructions: "server context"
    });
    controller.setRotationProvider(async () => {
      throw new Error("client secret bootstrap unavailable");
    });
    now = 50 * 60 * 1000;

    await controller.rotateIfIdle();

    assert.equal(controller.status, "connected");
    assert.equal(controller.realtimeSessionId, "00000000-0000-0000-0000-000000000061");
    assert.deepEqual(first.calls, []);
    assert.deepEqual(lifecycle, ["connected:00000000-0000-0000-0000-000000000061"]);
  } finally {
    await controller.disconnect();
  }
});

test("rotation provider failure keeps the active wake turn fail-closed", async () => {
  const first = new FakeSession();
  const { stream, track } = fakeMediaStream();
  const wakeWord = fakeWakeWordDetector();
  let rejectProvider: ((reason: Error) => void) | undefined;
  let providerStarted: (() => void) | undefined;
  const providerStartedPromise = new Promise<void>(resolve => {
    providerStarted = resolve;
  });
  let now = 0;
  const controller = new DesktopRealtimeController(
    "conversation-rotation-provider-failure",
    {
      markConnected: async () => undefined,
      markEnded: async () => undefined,
      ingest: async () => undefined
    },
    () => undefined,
    () => now,
    () => first as unknown as RealtimeSession,
    () => new FakeTransport() as never
  );
  controller.setWakeWordDetector(wakeWord.detector);

  try {
    await controller.connect({
      realtimeSessionId: "00000000-0000-0000-0000-000000000094",
      clientSecret: "ek_scripted",
      model: "model",
      voice: "voice",
      instructions: "server context",
      mediaStream: stream
    });
    wakeWord.detect();
    controller.setRotationProvider(() => new Promise((_, reject) => {
      rejectProvider = reject;
      providerStarted?.();
    }));
    now = 50 * 60 * 1000;

    const rotating = controller.rotateIfIdle();
    let timeoutId: NodeJS.Timeout | undefined;
    const providerTimeout = new Promise<never>((_, reject) => {
      timeoutId = setTimeout(() => {
        reject(new Error("rotation provider was not called within the bounded test window"));
      }, 250);
    });
    try {
      await Promise.race([providerStartedPromise, providerTimeout]);
    } finally {
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
    }

    assert.ok(rejectProvider);
    assert.equal(controller.wakeState, "standby");
    assert.equal(track.enabled, false);
    rejectProvider(new Error("client secret bootstrap unavailable"));
    await rotating;

    assert.equal(controller.wakeState, "standby");
    assert.equal(track.enabled, false);
  } finally {
    await controller.disconnect();
  }
});

test("rotation prepare failure does not restore an awake wake turn", async () => {
  const first = new FakeSession();
  const failedReplacement = new FakeSession(false, new Error("replacement unavailable"));
  const sessions = [first, failedReplacement];
  const { stream, track } = fakeMediaStream();
  const wakeWord = fakeWakeWordDetector();
  let sessionIndex = 0;
  let now = 0;
  const controller = new DesktopRealtimeController(
    "conversation-rotation-prepare-failure",
    {
      markConnected: async () => undefined,
      markEnded: async () => undefined,
      ingest: async () => undefined
    },
    () => undefined,
    () => now,
    () => sessions[sessionIndex++] as unknown as RealtimeSession,
    () => new FakeTransport() as never
  );
  controller.setWakeWordDetector(wakeWord.detector);

  try {
    await controller.connect({
      realtimeSessionId: "00000000-0000-0000-0000-000000000095",
      clientSecret: "ek_scripted",
      model: "model",
      voice: "voice",
      instructions: "server context",
      mediaStream: stream
    });
    wakeWord.detect();
    controller.setRotationProvider(async () => ({
      realtimeSessionId: "00000000-0000-0000-0000-000000000096",
      clientSecret: "ek_scripted-2",
      model: "model",
      voice: "voice",
      instructions: "server context after rotation"
    }));
    now = 50 * 60 * 1000;

    await controller.rotateIfIdle();

    assert.equal(controller.status, "connected");
    assert.equal(controller.wakeState, "standby");
    assert.equal(track.enabled, false);
  } finally {
    await controller.disconnect();
  }
});

test("disconnect persistence failure keeps the controller reachable for an explicit retry", async () => {
  const fakeSession = new FakeSession();
  let failPersistence = true;
  const ingestedEventIds: string[] = [];
  const attemptedBatchKeys: string[] = [];
  const controller = new DesktopRealtimeController(
    "conversation-disconnect-retry",
    {
      markConnected: async () => undefined,
      markEnded: async () => undefined,
      ingest: async input => {
        attemptedBatchKeys.push(input.idempotencyKey);
        if (failPersistence) {
          throw new Error("persistence unavailable");
        }
        ingestedEventIds.push(...input.events.map(event => event.eventId));
      }
    },
    () => undefined,
    () => 0,
    () => fakeSession as unknown as RealtimeSession
  );

  try {
    await controller.connect({
      realtimeSessionId: "00000000-0000-0000-0000-000000000062",
      clientSecret: "ek_scripted",
      model: "model",
      voice: "voice",
      instructions: "server context"
    });
    fakeSession.transport.emit("output_text_delta", { itemId: "retry-item", delta: "待重试", responseId: "response-1" });

    assert.equal(await controller.disconnect("user-requested"), false);
    assert.equal(controller.status, "degraded");
    assert.equal(controller.realtimeSessionId, "00000000-0000-0000-0000-000000000062");
    assert.deepEqual(fakeSession.calls, []);

    failPersistence = false;
    assert.equal(await controller.retryPersistence(), true);
    assert.equal(controller.status, "connected");
    assert.equal(ingestedEventIds.length, 1);
    assert.equal(attemptedBatchKeys.length, 2);
    assert.equal(attemptedBatchKeys[0], attemptedBatchKeys[1]);
    assert.equal(await controller.disconnect("user-requested"), true);
  } finally {
    failPersistence = false;
    await controller.disconnect();
  }
});

test("disconnect fails closed before waiting for a persistence retry", async () => {
  const fakeSession = new FakeSession();
  const { stream, track } = fakeMediaStream();
  const wakeWord = fakeWakeWordDetector();
  let failPersistence = true;
  const controller = new DesktopRealtimeController(
    "conversation-disconnect-awake",
    {
      markConnected: async () => undefined,
      markEnded: async () => undefined,
      ingest: async () => {
        if (failPersistence) {
          throw new Error("persistence unavailable");
        }
      }
    },
    () => undefined,
    () => 0,
    () => fakeSession as unknown as RealtimeSession,
    () => new FakeTransport() as never
  );
  controller.setWakeWordDetector(wakeWord.detector);

  try {
    await controller.connect({
      realtimeSessionId: "00000000-0000-0000-0000-000000000087",
      clientSecret: "ek_scripted",
      model: "model",
      voice: "voice",
      instructions: "server context",
      mediaStream: stream
    });
    wakeWord.detect();
    fakeSession.transport.emit("output_text_delta", {
      itemId: "disconnect-item",
      delta: "待落库",
      responseId: "response-1"
    });

    assert.equal(await controller.disconnect("user-requested"), false);
    assert.equal(controller.wakeState, "standby");
    assert.equal(track.enabled, false);
  } finally {
    failPersistence = false;
    await controller.disconnect();
  }
});

test("spontaneous disconnect retains a failed terminal update for explicit retry", async () => {
  const fakeSession = new FakeSession();
  let failTerminalUpdate = true;
  const attemptedEndKeys: string[] = [];
  const controller = new DesktopRealtimeController(
    "conversation-spontaneous-disconnect-retry",
    {
      markConnected: async () => undefined,
      markEnded: async input => {
        if (input.status === "failed") {
          attemptedEndKeys.push(input.idempotencyKey);
          if (failTerminalUpdate) {
            throw new Error("terminal update unavailable");
          }
        }
      },
      ingest: async () => undefined
    },
    () => undefined,
    () => 0,
    () => fakeSession as unknown as RealtimeSession
  );

  try {
    await controller.connect({
      realtimeSessionId: "00000000-0000-0000-0000-000000000097",
      clientSecret: "ek_scripted",
      model: "model",
      voice: "voice",
      instructions: "server context"
    });

    fakeSession.transport.emit("connection_change", "disconnected");
    await new Promise<void>(resolve => setImmediate(resolve));

    assert.equal(controller.status, "degraded");
    assert.equal(attemptedEndKeys.length, 1);

    failTerminalUpdate = false;
    assert.equal(await controller.retryPersistence(), true);
    assert.equal(attemptedEndKeys.length, 2);
    assert.equal(attemptedEndKeys[0], attemptedEndKeys[1]);
    assert.equal(controller.status, "disconnected");
  } finally {
    failTerminalUpdate = false;
    await controller.disconnect();
  }
});

test("typed messages remain available while wake state is standby or error", async () => {
  const fakeSession = new FakeSession();
  const { stream } = fakeMediaStream();
  const wakeWord = fakeWakeWordDetector();
  const persisted: string[] = [];
  const controller = new DesktopRealtimeController(
    "conversation-typed-wake-independent",
    {
      markConnected: async () => undefined,
      markEnded: async () => undefined,
      ingest: async () => undefined
    },
    () => undefined,
    () => 0,
    () => fakeSession as unknown as RealtimeSession,
    () => new FakeTransport() as never
  );
  controller.setWakeWordDetector(wakeWord.detector);

  try {
    await controller.connect({
      realtimeSessionId: "00000000-0000-0000-0000-000000000098",
      clientSecret: "ek_scripted",
      model: "model",
      voice: "voice",
      instructions: "server context",
      mediaStream: stream
    });
    await controller.sendTyped("standby typed", async text => persisted.push(text));

    wakeWord.fail();
    assert.equal(controller.wakeState, "error");
    await controller.sendTyped("error typed", async text => persisted.push(text));

    assert.deepEqual(persisted, ["standby typed", "error typed"]);
  } finally {
    await controller.disconnect();
  }
});

test("failed rotated lifecycle closes the old transport and retries with the same operation", async () => {
  const first = new FakeSession();
  const second = new FakeSession();
  const sessions = [first, second];
  const lifecycle: string[] = [];
  const rotatedEndKeys: string[] = [];
  let failRotatedEnd = true;
  let sessionIndex = 0;
  let now = 0;
  const controller = new DesktopRealtimeController(
    "conversation-rotation-end-retry",
    {
      markConnected: async input => lifecycle.push(`connected:${input.sessionId}`),
      markEnded: async input => {
        lifecycle.push(`ended:${input.sessionId}:${input.status}`);
        if (input.status === "rotated") {
          rotatedEndKeys.push(input.idempotencyKey);
        }
        if (input.status === "rotated" && failRotatedEnd) {
          throw new Error("lifecycle persistence unavailable");
        }
      },
      ingest: async () => undefined
    },
    () => undefined,
    () => now,
    () => sessions[sessionIndex++] as unknown as RealtimeSession
  );

  try {
    await controller.connect({
      realtimeSessionId: "00000000-0000-0000-0000-000000000071",
      clientSecret: "ek_scripted",
      model: "model",
      voice: "voice",
      instructions: "server context"
    });
    controller.setRotationProvider(async () => ({
      realtimeSessionId: "00000000-0000-0000-0000-000000000072",
      clientSecret: "ek_scripted-2",
      model: "model",
      voice: "voice",
      instructions: "server context after rotation"
    }));
    now = 50 * 60 * 1000;

    await controller.rotateIfIdle();

    assert.equal(controller.realtimeSessionId, "00000000-0000-0000-0000-000000000072");
    assert.equal(controller.status, "connected");
    assert.deepEqual(first.calls, ["close"]);
    assert.deepEqual(second.calls, []);
    assert.equal(lifecycle.filter(item => item.includes(":rotated")).length, 1);

    failRotatedEnd = false;
    assert.equal(await controller.retryPersistence(), true);
    assert.equal(lifecycle.filter(item => item.includes(":rotated")).length, 2);
    assert.equal(rotatedEndKeys[0], rotatedEndKeys[1]);
  } finally {
    failRotatedEnd = false;
    await controller.disconnect();
  }
});

test("audio interruption persists only SDK-confirmed truncated history", async () => {
  const fakeSession = new FakeSession();
  const persisted: Array<{ status: string; text?: string }> = [];
  const controller = new DesktopRealtimeController(
    "conversation-interruption",
    {
      markConnected: async () => undefined,
      markEnded: async () => undefined,
      ingest: async input => {
        persisted.push(...input.events.map(event => ({ status: event.status, text: event.text })));
      }
    },
    () => undefined,
    () => 0,
    () => fakeSession as unknown as RealtimeSession
  );

  try {
    await controller.connect({
      realtimeSessionId: "00000000-0000-0000-0000-000000000031",
      clientSecret: "ek_scripted",
      model: "model",
      voice: "voice",
      instructions: "server context"
    });
    fakeSession.transport.emit("audio_transcript_delta", {
      itemId: "assistant-item",
      delta: "未确认的增量",
      responseId: "response-1"
    });
    fakeSession.emit("audio_interrupted");
    await Promise.resolve();
    assert.equal(persisted.some(item => item.status === "interrupted"), false);

    fakeSession.history = [{
      itemId: "assistant-item",
      type: "message",
      role: "assistant",
      status: "incomplete",
      content: [{ type: "output_audio", transcript: "已确认的截断文本", audio: null }]
    }];
    fakeSession.emit("history_updated", fakeSession.history);
    await controller.flushPendingPersistence();

    assert.deepEqual(persisted, [{ status: "streaming", text: "未确认的增量" }, { status: "interrupted", text: "已确认的截断文本" }]);
  } finally {
    await controller.disconnect();
  }
});

test("buffers multiple realtime events into one bounded ingest batch", async () => {
  const fakeSession = new FakeSession();
  const ingests: NormalizedRealtimeEvent[][] = [];
  const controller = new DesktopRealtimeController(
    "conversation-batch",
    {
      markConnected: async () => undefined,
      markEnded: async () => undefined,
      ingest: async input => {
        ingests.push(input.events);
      }
    },
    () => undefined,
    () => 0,
    () => fakeSession as unknown as RealtimeSession
  );

  try {
    await controller.connect({
      realtimeSessionId: "00000000-0000-0000-0000-000000000041",
      clientSecret: "ek_scripted",
      model: "model",
      voice: "voice",
      instructions: "server context"
    });
    fakeSession.transport.emit("output_text_delta", { itemId: "item-1", delta: "一", responseId: "response-1" });
    fakeSession.transport.emit("output_text_delta", { itemId: "item-1", delta: "二", responseId: "response-1" });

    assert.equal(await controller.flushPendingPersistence(), true);
    assert.equal(ingests.length, 1);
    assert.equal(ingests[0]!.length, 2);
    assert.notEqual(ingests[0]![0]!.eventId, ingests[0]![1]!.eventId);
  } finally {
    await controller.disconnect();
  }
});

test("flush drains events queued while an ingest request is resolving", async () => {
  const fakeSession = new FakeSession();
  const ingests: NormalizedRealtimeEvent[][] = [];
  let releaseFirstIngest: (() => void) | undefined;
  let firstIngest = true;
  const controller = new DesktopRealtimeController(
    "conversation-flush-race",
    {
      markConnected: async () => undefined,
      markEnded: async () => undefined,
      ingest: async input => {
        ingests.push(input.events);
        if (firstIngest) {
          firstIngest = false;
          await new Promise<void>(resolve => {
            releaseFirstIngest = resolve;
          });
        }
      }
    },
    () => undefined,
    () => 0,
    () => fakeSession as unknown as RealtimeSession
  );

  try {
    await controller.connect({
      realtimeSessionId: "00000000-0000-0000-0000-000000000042",
      clientSecret: "ek_scripted",
      model: "model",
      voice: "voice",
      instructions: "server context"
    });
    fakeSession.transport.emit("output_text_delta", { itemId: "item-1", delta: "一", responseId: "response-1" });
    const flush = controller.flushPendingPersistence();
    assert.ok(releaseFirstIngest);
    releaseFirstIngest();
    queueMicrotask(() => {
      fakeSession.transport.emit("output_text_delta", { itemId: "item-2", delta: "二", responseId: "response-1" });
    });

    assert.equal(await flush, true);
    assert.equal(ingests.length, 2);
    assert.equal(ingests[0]![0]!.externalItemId, "item-1");
    assert.equal(ingests[1]![0]!.externalItemId, "item-2");
  } finally {
    await controller.disconnect();
  }
});

test("persistence failure blocks rotation until the same event batch retries", async () => {
  const first = new FakeSession();
  const second = new FakeSession();
  const sessions = [first, second];
  const lifecycle: string[] = [];
  let sessionIndex = 0;
  let now = 0;
  let failPersistence = true;
  let rotationRequests = 0;
  const controller = new DesktopRealtimeController(
    "conversation-persistence-failure",
    {
      markConnected: async input => lifecycle.push(`connected:${input.sessionId}`),
      markEnded: async input => lifecycle.push(`ended:${input.sessionId}:${input.status}`),
      ingest: async input => {
        if (failPersistence) {
          throw new Error("persistence unavailable");
        }
        lifecycle.push(`ingest:${input.events.length}:${input.events[0]!.eventId}`);
      }
    },
    () => undefined,
    () => now,
    () => sessions[sessionIndex++] as unknown as RealtimeSession
  );

  try {
    await controller.connect({
      realtimeSessionId: "00000000-0000-0000-0000-000000000051",
      clientSecret: "ek_scripted",
      model: "model",
      voice: "voice",
      instructions: "server context"
    });
    first.transport.emit("output_text_delta", { itemId: "item-failure", delta: "待落库", responseId: "response-1" });
    first.transport.emit("audio_done");
    assert.equal(await controller.flushPendingPersistence(), false);

    controller.setRotationProvider(async () => {
      rotationRequests++;
      return {
        realtimeSessionId: "00000000-0000-0000-0000-000000000052",
        clientSecret: "ek_scripted-2",
        model: "model",
        voice: "voice",
        instructions: "server context"
      };
    });
    now = 50 * 60 * 1000;
    await controller.rotateIfIdle();
    assert.equal(rotationRequests, 0);
    assert.equal(controller.realtimeSessionId, "00000000-0000-0000-0000-000000000051");
    assert.equal(lifecycle.some(item => item.includes(":rotated")), false);

    failPersistence = false;
    await controller.rotateIfIdle();
    assert.equal(rotationRequests, 1);
    assert.equal(controller.realtimeSessionId, "00000000-0000-0000-0000-000000000052");
    assert.equal(lifecycle.some(item => item.includes(":rotated")), true);
  } finally {
    failPersistence = false;
    await controller.disconnect();
  }
});
