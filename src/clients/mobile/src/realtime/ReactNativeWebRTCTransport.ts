import {
  OpenAIRealtimeBase,
  type OpenAIRealtimeBaseOptions,
  type RealtimeClientMessage,
  type RealtimeSessionConfig,
  type RealtimeTransportLayerConnectOptions
} from "@openai/agents-realtime";

export type NativeAudioTrack = {
  enabled: boolean;
  stop: () => void;
};

export type NativeMediaStream = {
  getAudioTracks: () => readonly NativeAudioTrack[];
};

export type NativeDataChannel = {
  readyState: "connecting" | "open" | "closing" | "closed";
  addEventListener: (type: string, listener: (event: NativeDataChannelEvent) => void) => void;
  removeEventListener: (type: string, listener: (event: NativeDataChannelEvent) => void) => void;
  send: (value: string) => void;
  close: () => void;
};

export type NativeDataChannelEvent = { data?: unknown };

export type NativePeerConnection = {
  connectionState: "new" | "connecting" | "connected" | "disconnected" | "failed" | "closed";
  createDataChannel: (label: string) => NativeDataChannel;
  addTrack: (track: NativeAudioTrack, stream?: NativeMediaStream) => void;
  createOffer: () => Promise<{ type: "offer"; sdp?: string }>;
  setLocalDescription: (description: { type: "offer"; sdp?: string }) => Promise<void>;
  setRemoteDescription: (description: { type: "answer"; sdp: string }) => Promise<void>;
  getSenders: () => readonly { track: NativeAudioTrack | null }[];
  close: () => void;
  onconnectionstatechange?: (() => void) | null;
  ontrack?: ((event: { streams?: readonly NativeMediaStream[] }) => void) | null;
};

export type NativeSdpResponse = {
  ok: boolean;
  status: number;
  statusText?: string;
  headers: { get: (name: string) => string | null };
  text: () => Promise<string>;
};

export type NativeWebRTCBoundary = {
  createPeerConnection: () => NativePeerConnection;
  getUserMedia: () => Promise<NativeMediaStream>;
  postSdp: (
    url: string,
    init: { body: string; headers: Record<string, string> }
  ) => Promise<NativeSdpResponse>;
};

type ConnectAttemptResources = {
  attempt: number;
  connection?: NativePeerConnection;
  dataChannel?: NativeDataChannel;
  inputStream?: NativeMediaStream;
  inputTrack?: NativeAudioTrack;
  remoteStream?: NativeMediaStream;
  dataChannelMessageListener?: (event: NativeDataChannelEvent) => void;
  dataChannelErrorListener?: (event: NativeDataChannelEvent) => void;
  dataChannelCloseListener?: (event: NativeDataChannelEvent) => void;
  cancelled: boolean;
  cleaned: boolean;
  cancellation: Promise<never>;
  rejectCancellation: (error: Error) => void;
  cancelError?: Error;
};

export type ReactNativeWebRTCTransportOptions = OpenAIRealtimeBaseOptions & {
  boundary: NativeWebRTCBoundary;
  baseUrl?: string;
  /**
   * Bounds the initial session.update handshake. The production default keeps
   * a transport from being left in connecting forever when the server never
   * acknowledges the session configuration; tests may use a shorter bound.
   */
  sessionUpdatedAckTimeoutMs?: number;
};

/**
 * Agents SDK transport for React Native's WebRTC implementation.
 *
 * The boundary deliberately owns all native objects. This class never registers
 * browser globals and never retains the ephemeral API key after connect().
 */
export class ReactNativeWebRTCTransport extends OpenAIRealtimeBase {
  private readonly boundary: NativeWebRTCBoundary;
  private readonly baseUrl: string;
  private readonly sessionUpdatedAckTimeoutMs: number;
  private state: "connected" | "disconnected" | "connecting" = "disconnected";
  private connection: NativePeerConnection | undefined;
  private dataChannel: NativeDataChannel | undefined;
  private inputStream: NativeMediaStream | undefined;
  private inputTrack: NativeAudioTrack | undefined;
  private remoteStream: NativeMediaStream | undefined;
  private connectPromise: Promise<void> | undefined;
  private activeAttempt: ConnectAttemptResources | undefined;
  private connectAttempt = 0;
  private mutedState = false;

  public constructor(options: ReactNativeWebRTCTransportOptions) {
    super(options);
    this.boundary = options.boundary;
    this.baseUrl = options.baseUrl ?? "https://api.openai.com/v1/realtime/calls";
    this.sessionUpdatedAckTimeoutMs = options.sessionUpdatedAckTimeoutMs ?? 5_000;
  }

  public get status(): "connected" | "disconnected" | "connecting" {
    return this.state;
  }

  public get muted(): boolean {
    return this.mutedState;
  }

  public async connect(options: RealtimeTransportLayerConnectOptions): Promise<void> {
    if (this.state === "connected") {
      return;
    }
    if (this.connectPromise) {
      return this.connectPromise;
    }

    const attempt = ++this.connectAttempt;
    const resources = this.createAttemptResources(attempt);
    this.activeAttempt = resources;
    this.state = "connecting";
    this.emit("connection_change", this.state);
    this.connectPromise = this.establish(options, resources).finally(() => {
      if (this.connectAttempt === attempt) {
        this.connectPromise = undefined;
      }
    });
    return this.connectPromise;
  }

  public sendEvent(event: RealtimeClientMessage): void {
    this.assertDataChannel();
    this.dataChannel!.send(JSON.stringify(event));
  }

  public requestResponse(response?: Record<string, unknown>): void {
    this.sendEvent({
      type: "response.create",
      ...(response ? { response } : {})
    });
  }

  public mute(muted: boolean): void {
    this.mutedState = muted;
    for (const sender of this.connection?.getSenders() ?? []) {
      if (sender.track) {
        sender.track.enabled = !muted;
      }
    }
  }

  public interrupt(): void {
    if (!this.isDataChannelOpen()) {
      return;
    }

    this.sendEvent({ type: "response.cancel" });
    this.sendEvent({ type: "output_audio_buffer.clear" });
  }

  public close(): void {
    const wasActive = this.state !== "disconnected" || this.activeAttempt !== undefined;
    const resources = this.activeAttempt;
    ++this.connectAttempt;
    if (resources) {
      this.cancelAttempt(resources, new Error("Realtime connection was closed during setup."));
      this.activeAttempt = undefined;
    }
    this.state = "disconnected";
    this.connectPromise = undefined;

    if (wasActive) {
      this.emit("connection_change", "disconnected");
      this._onClose();
    }
  }

  private async establish(
    options: RealtimeTransportLayerConnectOptions,
    resources: ConnectAttemptResources
  ): Promise<void> {
    const { attempt } = resources;
    try {
      const apiKey = await this.awaitAttempt(this._getApiKey(options), attempt, resources);
      if (!apiKey.startsWith("ek_")) {
        this.failConnect(attempt, new Error("React Native Realtime requires an ephemeral client secret."));
      }

      const connection = this.boundary.createPeerConnection();
      resources.connection = connection;
      this.connection = connection;
      const dataChannel = connection.createDataChannel("oai-events");
      resources.dataChannel = dataChannel;
      this.dataChannel = dataChannel;
      const stream = await this.awaitAttempt(
        this.boundary.getUserMedia(),
        attempt,
        resources,
        lateStream => this.stopMediaStreamTracks(lateStream));
      resources.inputStream = stream;
      this.inputStream = stream;
      const track = stream.getAudioTracks()[0];
      if (!track) {
        this.failConnect(attempt, new Error("The microphone did not provide an audio track."));
      }

      resources.inputTrack = track;
      this.inputTrack = track;
      track.enabled = !this.mutedState;
      connection.onconnectionstatechange = () => {
        if (!this.isAttemptActive(resources)) {
          return;
        }
        if (connection.connectionState === "failed" || connection.connectionState === "closed") {
          this.close();
        }
      };
      connection.ontrack = event => {
        // Keep the native remote stream referenced while WebRTC routes peer audio.
        const remoteStream = event.streams?.[0];
        resources.remoteStream = remoteStream;
        if (resources.cancelled) {
          this.stopMediaStreamTracks(remoteStream);
          return;
        }
        this.remoteStream = remoteStream;
      };
      resources.dataChannelMessageListener = event => {
        if (this.dataChannel !== dataChannel || resources.cancelled || event.data === undefined) {
          return;
        }
        try {
          this._onMessage({ data: event.data } as MessageEvent);
        } catch (error) {
          this._onError(error);
        }
      };
      resources.dataChannelErrorListener = event => {
        if (!resources.cancelled) {
          this._onError(event);
        }
      };
      resources.dataChannelCloseListener = () => {
        if (this.dataChannel === dataChannel && this.state !== "disconnected") {
          this.close();
        }
      };
      dataChannel.addEventListener("message", resources.dataChannelMessageListener);
      dataChannel.addEventListener("error", resources.dataChannelErrorListener);
      dataChannel.addEventListener("close", resources.dataChannelCloseListener);

      connection.addTrack(track, stream);
      const offer = await this.awaitAttempt(connection.createOffer(), attempt, resources);
      if (!offer.sdp) {
        this.failConnect(attempt, new Error("Failed to create the native WebRTC offer."));
      }
      await this.awaitAttempt(connection.setLocalDescription(offer), attempt, resources);
      const response = await this.awaitAttempt(
        this.boundary.postSdp(
          options.url ?? this.baseUrl,
          {
            body: offer.sdp,
            headers: {
              Authorization: `Bearer ${apiKey}`,
              "Content-Type": "application/sdp"
            }
          }),
        attempt,
        resources);
      if (!response.ok) {
        const detail = await this.awaitAttempt(response.text().catch(() => ""), attempt, resources);
        this.failConnect(
          attempt,
          new Error(`Realtime call request failed with status ${response.status}${detail ? `: ${detail}` : ""}`));
      }
      const answer = await this.awaitAttempt(response.text(), attempt, resources);
      await this.awaitAttempt(
        connection.setRemoteDescription({ type: "answer", sdp: answer }),
        attempt,
        resources);
      await this.waitForDataChannelOpen(dataChannel, attempt, resources);

      this.assertAttemptActive(resources);

      this.currentModel = options.model ?? this.currentModel;
      await this.sendInitialSessionConfig(dataChannel, attempt, resources, {
        ...(options.initialSessionConfig ?? {}),
        model: this.currentModel
      });

      this.assertAttemptActive(resources);

      this.state = "connected";
      this.emit("connection_change", this.state);
      this._onOpen();
    } catch (error) {
      if (this.isAttemptActive(resources)) {
        this.close();
      }
      throw error;
    }
  }

  private async waitForDataChannelOpen(
    dataChannel: NativeDataChannel,
    attempt: number,
    resources: ConnectAttemptResources
  ): Promise<void> {
    if (dataChannel.readyState === "open") {
      return;
    }
    if (dataChannel.readyState === "closed") {
      throw new Error("Realtime data channel closed before setup completed.");
    }

    let cleanup = (): void => undefined;
    const openPromise = new Promise<void>((resolve, reject) => {
      const onOpen = (): void => {
        cleanup();
        resolve();
      };
      const onClose = (): void => {
        cleanup();
        reject(new Error("Realtime data channel closed before setup completed."));
      };
      cleanup = (): void => {
        dataChannel.removeEventListener("open", onOpen);
        dataChannel.removeEventListener("close", onClose);
      };
      dataChannel.addEventListener("open", onOpen);
      dataChannel.addEventListener("close", onClose);
      if (!this.isAttemptActive(resources)) {
        cleanup();
        reject(new Error("Realtime connection was closed during setup."));
      }
    });
    try {
      await this.awaitAttempt(openPromise, attempt, resources);
    } finally {
      cleanup();
    }
  }

  private async sendInitialSessionConfig(
    dataChannel: NativeDataChannel,
    attempt: number,
    resources: ConnectAttemptResources,
    config: Partial<RealtimeSessionConfig>
  ): Promise<void> {
    if (dataChannel.readyState === "closed") {
      throw new Error("Realtime data channel closed before session config was acknowledged.");
    }

    let cleanup = (): void => undefined;
    const acknowledgementPromise = new Promise<void>((resolve, reject) => {
      let settled = false;
      const timeoutId = setTimeout(() => {
        finish(new Error("Timed out waiting for the Realtime session.updated acknowledgement."));
      }, this.sessionUpdatedAckTimeoutMs);
      function cleanupAcknowledgement(): void {
        clearTimeout(timeoutId);
        dataChannel.removeEventListener("message", onMessage);
        dataChannel.removeEventListener("close", onClose);
      }
      function finish(error?: Error): void {
        if (settled) {
          return;
        }
        settled = true;
        cleanupAcknowledgement();
        if (error) {
          reject(error);
        } else {
          resolve();
        }
      }
      cleanup = cleanupAcknowledgement;
      const onMessage = (event: NativeDataChannelEvent): void => {
        if (this.isSessionUpdatedMessage(event.data)) {
          finish();
        }
      };
      const onClose = (): void => {
        finish(new Error("Realtime data channel closed before session config was acknowledged."));
      };

      // The acknowledgement listener must be installed before updateSessionConfig
      // sends the request. It is intentionally additive: the transport's normal
      // message handler remains subscribed and emits the same session.updated event.
      dataChannel.addEventListener("message", onMessage);
      dataChannel.addEventListener("close", onClose);

      if (this.connectAttempt !== attempt || this.dataChannel !== dataChannel) {
        finish(new Error("Realtime connection was closed during session setup."));
        return;
      }
      try {
        this.updateSessionConfig(config);
      } catch (error) {
        finish(error instanceof Error ? error : new Error(String(error)));
      }
    });
    try {
      await this.awaitAttempt(acknowledgementPromise, attempt, resources);
    } finally {
      cleanup();
    }
  }

  private isSessionUpdatedMessage(data: unknown): boolean {
    let payload: unknown = data;
    if (typeof data === "string") {
      try {
        payload = JSON.parse(data) as unknown;
      } catch {
        return false;
      }
    }
    return typeof payload === "object" && payload !== null &&
      (payload as { type?: unknown }).type === "session.updated";
  }

  private createAttemptResources(attempt: number): ConnectAttemptResources {
    let rejectCancellation!: (error: Error) => void;
    const cancellation = new Promise<never>((_, reject) => {
      rejectCancellation = reject;
    });
    // A completed connection has no pending awaiters, but close() still rejects
    // this shared cancellation signal to make every delayed checkpoint uniform.
    // Attach a handler so that cleanup after a successful call cannot become an
    // unhandled rejection in the JS runtime.
    void cancellation.catch(() => undefined);
    return {
      attempt,
      cancelled: false,
      cleaned: false,
      cancellation,
      rejectCancellation
    };
  }

  private isAttemptActive(resources: ConnectAttemptResources): boolean {
    return !resources.cancelled && this.activeAttempt === resources &&
      this.connectAttempt === resources.attempt;
  }

  private assertAttemptActive(resources: ConnectAttemptResources): void {
    if (!this.isAttemptActive(resources)) {
      throw resources.cancelError ?? new Error("Realtime connection was closed during setup.");
    }
  }

  private async awaitAttempt<T>(
    operation: Promise<T>,
    attempt: number,
    resources: ConnectAttemptResources,
    cleanupLateValue?: (value: T) => void
  ): Promise<T> {
    this.assertAttemptActive(resources);
    const guardedOperation = Promise.resolve(operation).then(value => {
      if (!this.isAttemptActive(resources) || this.connectAttempt !== attempt) {
        cleanupLateValue?.(value);
        throw resources.cancelError ?? new Error("Realtime connection was closed during setup.");
      }
      return value;
    });
    return Promise.race([guardedOperation, resources.cancellation]);
  }

  private cancelAttempt(resources: ConnectAttemptResources, error: Error): void {
    if (!resources.cancelled) {
      resources.cancelled = true;
      resources.cancelError = error;
      resources.rejectCancellation(error);
    }
    this.cleanupAttempt(resources);
  }

  private assertDataChannel(): void {
    if (!this.isDataChannelOpen()) {
      throw new Error("React Native WebRTC data channel is not connected.");
    }
  }

  private isDataChannelOpen(): boolean {
    return this.dataChannel?.readyState === "open";
  }

  private failConnect(attempt: number, error: Error): never {
    if (this.connectAttempt === attempt) {
      this.close();
    }
    throw error;
  }

  private cleanupAttempt(resources: ConnectAttemptResources): void {
    if (resources.cleaned) {
      return;
    }
    resources.cleaned = true;

    const connection = resources.connection;
    const dataChannel = resources.dataChannel;
    const messageListener = resources.dataChannelMessageListener;
    const errorListener = resources.dataChannelErrorListener;
    const closeListener = resources.dataChannelCloseListener;
    if (dataChannel) {
      if (messageListener) {
        dataChannel.removeEventListener("message", messageListener);
      }
      if (errorListener) {
        dataChannel.removeEventListener("error", errorListener);
      }
      if (closeListener) {
        dataChannel.removeEventListener("close", closeListener);
      }
    }
    if (connection) {
      connection.onconnectionstatechange = null;
      connection.ontrack = null;
    }

    const tracks = new Set<NativeAudioTrack>();
    this.addMediaStreamTracks(resources.inputStream, tracks);
    this.addMediaStreamTracks(resources.remoteStream, tracks);
    if (resources.inputTrack) {
      tracks.add(resources.inputTrack);
    }
    try {
      for (const sender of connection?.getSenders() ?? []) {
        if (sender.track) {
          tracks.add(sender.track);
        }
      }
    } catch {
      // Native peer connections can reject getSenders after suspension.
    }
    for (const track of tracks) {
      try {
        track.stop();
      } catch {
        // A native track can already be released by the OS.
      }
    }
    if (dataChannel) {
      try {
        dataChannel.close();
      } catch {
        // Cleanup is idempotent when native WebRTC has already closed it.
      }
    }
    if (connection) {
      try {
        connection.close();
      } catch {
        // Cleanup is idempotent when native WebRTC has already closed it.
      }
    }

    if (this.connection === connection) {
      this.connection = undefined;
    }
    if (this.dataChannel === dataChannel) {
      this.dataChannel = undefined;
    }
    if (this.inputStream === resources.inputStream) {
      this.inputStream = undefined;
    }
    if (this.inputTrack === resources.inputTrack) {
      this.inputTrack = undefined;
    }
    if (this.remoteStream === resources.remoteStream) {
      this.remoteStream = undefined;
    }
  }

  private addMediaStreamTracks(stream: NativeMediaStream | undefined, tracks: Set<NativeAudioTrack>): void {
    if (!stream) {
      return;
    }
    try {
      for (const track of stream.getAudioTracks()) {
        tracks.add(track);
      }
    } catch {
      // A stream can disappear while the OS tears down a suspended call.
    }
  }

  private stopMediaStreamTracks(stream: NativeMediaStream | undefined): void {
    const tracks = new Set<NativeAudioTrack>();
    this.addMediaStreamTracks(stream, tracks);
    for (const track of tracks) {
      try {
        track.stop();
      } catch {
        // A late stream may already have been released by the native runtime.
      }
    }
  }
}
