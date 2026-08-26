import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  ReactNativeWebRTCTransport,
  type NativeAudioTrack,
  type NativeDataChannel,
  type NativePeerConnection,
  type NativeWebRTCBoundary
} from "./ReactNativeWebRTCTransport.js";

class FakeAudioTrack implements NativeAudioTrack {
  public enabled = true;
  public stopped = false;

  stop(): void {
    this.stopped = true;
  }
}

class FakeDataChannel implements NativeDataChannel {
  public readyState: "connecting" | "open" | "closing" | "closed" = "connecting";
  public readonly sent: string[] = [];
  private readonly listeners = new Map<string, Set<(event: { data?: unknown }) => void>>();

  addEventListener(type: string, listener: (event: { data?: unknown }) => void): void {
    const listeners = this.listeners.get(type) ?? new Set();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type: string, listener: (event: { data?: unknown }) => void): void {
    this.listeners.get(type)?.delete(listener);
  }

  send(value: string): void {
    if (this.readyState !== "open") {
      throw new Error("channel is not open");
    }
    this.sent.push(value);
  }

  close(): void {
    this.readyState = "closed";
    this.emit("close", {});
  }

  open(): void {
    this.readyState = "open";
    this.emit("open", {});
  }

  receive(value: unknown): void {
    this.emit("message", { data: JSON.stringify(value) });
  }

  private emit(type: string, event: { data?: unknown }): void {
    for (const listener of this.listeners.get(type) ?? []) {
      listener(event);
    }
  }
}

class FakePeerConnection implements NativePeerConnection {
  public connectionState: NativePeerConnection["connectionState"] = "new";
  public readonly channel = new FakeDataChannel();
  public readonly senders: { track: NativeAudioTrack | null }[] = [];
  public remoteDescription: { type: "answer"; sdp: string } | undefined;
  public closed = false;

  public constructor(private readonly openDataChannelOnRemoteDescription = true) {}

  createDataChannel(): NativeDataChannel {
    return this.channel;
  }

  addTrack(track: NativeAudioTrack): void {
    this.senders.push({ track });
  }

  async createOffer(): Promise<{ type: "offer"; sdp: string }> {
    return { type: "offer", sdp: "fake-offer" };
  }

  async setLocalDescription(): Promise<void> {
    this.connectionState = "connecting";
  }

  async setRemoteDescription(description: { type: "answer"; sdp: string }): Promise<void> {
    this.remoteDescription = description;
    this.connectionState = "connected";
    if (this.openDataChannelOnRemoteDescription) {
      this.channel.open();
    }
    this.onconnectionstatechange?.();
  }

  getSenders(): readonly { track: NativeAudioTrack | null }[] {
    return this.senders;
  }

  close(): void {
    this.closed = true;
    this.connectionState = "closed";
    this.channel.close();
    this.onconnectionstatechange?.();
  }

  onconnectionstatechange?: () => void;
}

class ThrowingDataChannelPeer extends FakePeerConnection {
  override createDataChannel(): NativeDataChannel {
    throw new Error("data channel creation failed");
  }
}

async function nextTurn(): Promise<void> {
  await new Promise<void>(resolve => setImmediate(resolve));
}

async function assertRejectsPromptly(promise: Promise<void>, pattern: RegExp): Promise<void> {
  await assert.rejects(
    Promise.race([
      promise,
      new Promise<void>((_, reject) => {
        setTimeout(() => reject(new Error("connection promise did not settle")), 100);
      })
    ]),
    pattern);
}

test("ReactNativeWebRTCTransport uses ephemeral SDP signaling and cleans native resources", async () => {
  const track = new FakeAudioTrack();
  const peer = new FakePeerConnection();
  const requests: { url: string; body: string; authorization: string | null }[] = [];
  const boundary: NativeWebRTCBoundary = {
    createPeerConnection: () => peer,
    getUserMedia: async () => ({ getAudioTracks: () => [track] }),
    postSdp: async (url, init) => {
      requests.push({
        url,
        body: init.body,
        authorization: init.headers.Authorization
      });
      return {
        ok: true,
        status: 201,
        headers: {
          get: (name: string) => name.toLowerCase() === "location"
            ? "/v1/realtime/calls/call-123"
            : null
        },
        text: async () => "fake-answer"
      };
    }
  };

  const transport = new ReactNativeWebRTCTransport({ boundary });
  const connectPromise = transport.connect({
    apiKey: "ek_ephemeral",
    model: "gpt-realtime",
    initialSessionConfig: { instructions: "test" }
  });
  await new Promise<void>(resolve => setImmediate(resolve));
  peer.channel.receive({ type: "session.updated", event_id: "ack-1", session: {} });
  await connectPromise;

  assert.equal(transport.status, "connected");
  assert.deepEqual(requests, [{
    url: "https://api.openai.com/v1/realtime/calls",
    body: "fake-offer",
    authorization: "Bearer ek_ephemeral"
  }]);

  transport.mute(true);
  assert.equal(track.enabled, false);
  transport.sendEvent({ type: "response.cancel" });
  transport.interrupt();
  assert.ok(peer.channel.sent.some(value => value.includes("response.cancel")));
  assert.ok(peer.channel.sent.some(value => value.includes("output_audio_buffer.clear")));

  transport.close();
  transport.close();
  assert.equal(transport.status, "disconnected");
  assert.equal(track.stopped, true);
  assert.equal(peer.closed, true);
  assert.equal(peer.channel.readyState, "closed");
});

test("ReactNativeWebRTCTransport waits for the session.updated acknowledgement before connecting", async () => {
  const track = new FakeAudioTrack();
  const peer = new FakePeerConnection();
  const boundary: NativeWebRTCBoundary = {
    createPeerConnection: () => peer,
    getUserMedia: async () => ({ getAudioTracks: () => [track] }),
    postSdp: async () => ({
      ok: true,
      status: 201,
      headers: { get: () => null },
      text: async () => "fake-answer"
    })
  };

  const transport = new ReactNativeWebRTCTransport({ boundary });
  let sessionUpdatedEvents = 0;
  transport.on("session.updated", () => {
    sessionUpdatedEvents += 1;
  });

  let settled = false;
  const connectPromise = transport.connect({
    apiKey: "ek_ephemeral",
    model: "gpt-realtime",
    initialSessionConfig: { instructions: "test" }
  });
  void connectPromise.then(
    () => { settled = true; },
    () => { settled = true; });

  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(transport.status, "connecting");
  assert.equal(settled, false);
  assert.ok(peer.channel.sent.some(value => value.includes('"session.update"')));

  peer.channel.receive({ type: "session.updated", event_id: "ack-1", session: {} });
  await connectPromise;

  assert.equal(transport.status, "connected");
  assert.equal(sessionUpdatedEvents, 1);
  transport.close();
});

test("ReactNativeWebRTCTransport rejects a standard OpenAI key before native setup", async () => {
  let created = false;
  const boundary: NativeWebRTCBoundary = {
    createPeerConnection: () => {
      created = true;
      return new FakePeerConnection();
    },
    getUserMedia: async () => ({ getAudioTracks: () => [] }),
    postSdp: async () => {
      throw new Error("must not call OpenAI with a standard key");
    }
  };

  const transport = new ReactNativeWebRTCTransport({ boundary });
  await assert.rejects(
    transport.connect({ apiKey: "sk_standard_key" }),
    /ephemeral/i);
  assert.equal(created, false);
  assert.equal(transport.status, "disconnected");
});

test("ReactNativeWebRTCTransport cleans a peer when data-channel creation fails", async () => {
  const peer = new ThrowingDataChannelPeer();
  const boundary: NativeWebRTCBoundary = {
    createPeerConnection: () => peer,
    getUserMedia: async () => ({ getAudioTracks: () => [] }),
    postSdp: async () => {
      throw new Error("must not signal without a data channel");
    }
  };

  const transport = new ReactNativeWebRTCTransport({ boundary });
  await assert.rejects(transport.connect({ apiKey: "ek_ephemeral" }), /data channel creation failed/);
  assert.equal(peer.closed, true);
  assert.equal(transport.status, "disconnected");
});

test("ReactNativeWebRTCTransport closes delayed getUserMedia attempts and releases late tracks", async () => {
  const firstTrack = new FakeAudioTrack();
  const secondTrack = new FakeAudioTrack();
  const peer = new FakePeerConnection();
  let releaseStream!: (stream: { getAudioTracks: () => readonly FakeAudioTrack[] }) => void;
  const boundary: NativeWebRTCBoundary = {
    createPeerConnection: () => peer,
    getUserMedia: () => new Promise(resolve => {
      releaseStream = resolve;
    }),
    postSdp: async () => ({
      ok: true,
      status: 201,
      headers: { get: () => null },
      text: async () => "fake-answer"
    })
  };

  const transport = new ReactNativeWebRTCTransport({ boundary });
  const connectPromise = transport.connect({ apiKey: "ek_ephemeral" });
  await nextTurn();
  transport.close();
  await assertRejectsPromptly(connectPromise, /closed/i);

  releaseStream({ getAudioTracks: () => [firstTrack, secondTrack] });
  await nextTurn();
  assert.equal(firstTrack.stopped, true);
  assert.equal(secondTrack.stopped, true);
  assert.equal(peer.closed, true);
  assert.equal(peer.channel.readyState, "closed");
});

test("ReactNativeWebRTCTransport closes delayed SDP signaling attempts", async () => {
  const track = new FakeAudioTrack();
  const peer = new FakePeerConnection();
  let releaseResponse!: (response: {
    ok: boolean;
    status: number;
    headers: { get: (name: string) => string | null };
    text: () => Promise<string>;
  }) => void;
  const boundary: NativeWebRTCBoundary = {
    createPeerConnection: () => peer,
    getUserMedia: async () => ({ getAudioTracks: () => [track] }),
    postSdp: () => new Promise(resolve => {
      releaseResponse = resolve;
    })
  };

  const transport = new ReactNativeWebRTCTransport({ boundary });
  const connectPromise = transport.connect({ apiKey: "ek_ephemeral" });
  await nextTurn();
  transport.close();
  await assertRejectsPromptly(connectPromise, /closed/i);

  releaseResponse({
    ok: true,
    status: 201,
    headers: { get: () => null },
    text: async () => "fake-answer"
  });
  await nextTurn();
  assert.equal(track.stopped, true);
  assert.equal(peer.closed, true);
});

test("ReactNativeWebRTCTransport closes while waiting for a data channel", async () => {
  const track = new FakeAudioTrack();
  const peer = new FakePeerConnection(false);
  const boundary: NativeWebRTCBoundary = {
    createPeerConnection: () => peer,
    getUserMedia: async () => ({ getAudioTracks: () => [track] }),
    postSdp: async () => ({
      ok: true,
      status: 201,
      headers: { get: () => null },
      text: async () => "fake-answer"
    })
  };

  const transport = new ReactNativeWebRTCTransport({ boundary });
  const connectPromise = transport.connect({ apiKey: "ek_ephemeral" });
  await nextTurn();
  assert.equal(transport.status, "connecting");
  transport.close();
  await assertRejectsPromptly(connectPromise, /closed/i);
  assert.equal(track.stopped, true);
  assert.equal(peer.closed, true);
  assert.equal(peer.channel.readyState, "closed");
});

test("ReactNativeWebRTCTransport rejects an already-closed data channel", async () => {
  const track = new FakeAudioTrack();
  const peer = new FakePeerConnection(false);
  peer.channel.close();
  const boundary: NativeWebRTCBoundary = {
    createPeerConnection: () => peer,
    getUserMedia: async () => ({ getAudioTracks: () => [track] }),
    postSdp: async () => ({
      ok: true,
      status: 201,
      headers: { get: () => null },
      text: async () => "fake-answer"
    })
  };

  const transport = new ReactNativeWebRTCTransport({ boundary });
  await assert.rejects(transport.connect({ apiKey: "ek_ephemeral" }), /closed/i);
  assert.equal(track.stopped, true);
  assert.equal(peer.closed, true);
});

test("ReactNativeWebRTCTransport bounds the session.updated acknowledgement wait", async () => {
  const track = new FakeAudioTrack();
  const peer = new FakePeerConnection();
  const boundary: NativeWebRTCBoundary = {
    createPeerConnection: () => peer,
    getUserMedia: async () => ({ getAudioTracks: () => [track] }),
    postSdp: async () => ({
      ok: true,
      status: 201,
      headers: { get: () => null },
      text: async () => "fake-answer"
    })
  };

  const transport = new ReactNativeWebRTCTransport({
    boundary,
    sessionUpdatedAckTimeoutMs: 20
  });
  await assert.rejects(
    transport.connect({ apiKey: "ek_ephemeral", initialSessionConfig: { instructions: "test" } }),
    /timed out.*session\.updated/i);
  assert.equal(transport.status, "disconnected");
  assert.equal(track.stopped, true);
  assert.equal(peer.closed, true);
});

test("ReactNativeWebRTCTransport cleans native resources when SDP signaling fails", async () => {
  const track = new FakeAudioTrack();
  const peer = new FakePeerConnection();
  const boundary: NativeWebRTCBoundary = {
    createPeerConnection: () => peer,
    getUserMedia: async () => ({ getAudioTracks: () => [track] }),
    postSdp: async () => {
      throw new Error("network unavailable");
    }
  };

  const transport = new ReactNativeWebRTCTransport({ boundary });
  await assert.rejects(transport.connect({ apiKey: "ek_ephemeral" }), /network unavailable/);
  assert.equal(transport.status, "disconnected");
  assert.equal(track.stopped, true);
  assert.equal(peer.closed, true);
});
