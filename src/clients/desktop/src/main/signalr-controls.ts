export type SignalRPublishedState = "connecting" | "connected" | "reconnecting" | "disconnected";
export type SignalRControlState = SignalRPublishedState | "paused";

export type SignalRConnection = {
  start: () => Promise<void>;
  stop: () => Promise<void>;
};

export class SignalRControlCoordinator {
  private state: SignalRControlState = "disconnected";
  private operation: Promise<SignalRControlState> | undefined;

  public constructor(
    private readonly getConnection: () => SignalRConnection | undefined,
    private readonly publishState: (state: SignalRPublishedState, error?: Error) => void
  ) {}

  public getState(): SignalRControlState {
    return this.state;
  }

  public reportConnectionState(state: SignalRPublishedState, error?: Error): void {
    if (this.state === "paused") {
      return;
    }
    this.state = state;
    this.publishState(state, error);
  }

  public pause(): Promise<SignalRControlState> {
    if (this.operation) {
      return this.operation;
    }
    if (this.state === "paused") {
      return Promise.resolve(this.state);
    }

    const operation = this.performPause();
    const tracked = operation.finally(() => {
      if (this.operation === tracked) {
        this.operation = undefined;
      }
    });
    this.operation = tracked;
    return tracked;
  }

  public resume(): Promise<SignalRControlState> {
    if (this.operation) {
      return this.operation;
    }
    if (this.state !== "paused") {
      return Promise.resolve(this.state);
    }

    const operation = this.performResume();
    const tracked = operation.finally(() => {
      if (this.operation === tracked) {
        this.operation = undefined;
      }
    });
    this.operation = tracked;
    return tracked;
  }

  private async performPause(): Promise<SignalRControlState> {
    const previousState = this.state;
    this.state = "paused";
    try {
      await this.getConnection()?.stop();
      this.publishState("disconnected");
      return this.state;
    } catch (error) {
      this.state = previousState;
      throw error;
    }
  }

  private async performResume(): Promise<SignalRControlState> {
    const connection = this.getConnection();
    if (!connection) {
      this.state = "disconnected";
      this.publishState("disconnected");
      return this.state;
    }

    this.publishState("connecting");
    try {
      await connection.start();
      this.state = "connected";
      this.publishState("connected");
      return this.state;
    } catch (error) {
      this.state = "paused";
      this.publishState("disconnected", error instanceof Error ? error : undefined);
      throw error;
    }
  }
}
