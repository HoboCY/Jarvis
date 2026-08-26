import { HubConnectionBuilder, type HubConnection } from "@microsoft/signalr";
import { decodeSignalREventEnvelope } from "@jarvis/contracts-ts";
import type { MobileApiSession } from "../session/MobileApiSession";
import type { MobileSignalREvent, MobileTaskNotificationFeed } from "../feed/MobileTaskNotificationFeed";

export interface MobileHubConnection {
  on: (eventName: string, handler: (payload: unknown) => void) => void;
  onreconnected: (handler: () => void) => void;
  start: () => Promise<void>;
  stop: () => Promise<void>;
}

export interface MobileSignalRFeed {
  acceptEvent: (event: MobileSignalREvent) => boolean;
  refresh: () => Promise<void>;
}

export type MobileHubConnectionFactory = () => MobileHubConnection;

/** Foreground-only SignalR bridge; HTTP/SQLite remains the recovery authority. */
export class MobileSignalRConnection {
  private connection: MobileHubConnection | undefined;
  private connectPromise: Promise<void> | undefined;
  private recoveryPromise: Promise<void> = Promise.resolve();

  public constructor(
    private baseUrl: string,
    private readonly createConnection: MobileHubConnectionFactory,
    private readonly feed: MobileSignalRFeed
  ) {}

  public get apiBaseUrl(): string {
    return this.baseUrl;
  }

  public setBaseUrl(value: string): void {
    this.baseUrl = value;
  }

  public async connect(): Promise<void> {
    if (this.connection) {
      return;
    }
    if (this.connectPromise) {
      return this.connectPromise;
    }

    const connection = this.createConnection();
    this.connection = connection;
    for (const eventType of [
      "task.updated",
      "task.eventAdded",
      "notification.created",
      "notification.updated",
      "approval.required",
      "approval.resolved"
    ]) {
      connection.on(eventType, value => this.accept(value));
    }
    connection.onreconnected(() => {
      this.recoveryPromise = this.recoveryPromise
        .then(() => this.feed.refresh())
        .catch(() => undefined);
    });
    this.connectPromise = connection.start().catch(error => {
      if (this.connection === connection) {
        this.connection = undefined;
      }
      throw error;
    }).finally(() => {
      this.connectPromise = undefined;
    });
    return this.connectPromise;
  }

  public async disconnect(): Promise<void> {
    if (this.connectPromise) {
      await this.connectPromise.catch(() => undefined);
    }
    const connection = this.connection;
    this.connection = undefined;
    if (connection) {
      await connection.stop();
    }
  }

  public async whenIdle(): Promise<void> {
    await this.connectPromise?.catch(() => undefined);
    await this.recoveryPromise;
  }

  private accept(value: unknown): void {
    try {
      this.feed.acceptEvent(decodeSignalREventEnvelope(value));
    } catch {
      // SignalR is an optimization; malformed push data is recovered by HTTP.
    }
  }
}

export function createProductionMobileSignalRConnection(
  baseUrl: string,
  session: MobileApiSession,
  feed: MobileTaskNotificationFeed
): MobileSignalRConnection {
  const connectionRef: { value?: MobileSignalRConnection } = {};
  const mobileConnection = new MobileSignalRConnection(
    baseUrl,
    () => {
      const current = connectionRef.value;
      if (!current) {
        throw new Error("Mobile SignalR connection has not been initialized.");
      }
      return createHubConnection(current.apiBaseUrl, session);
    },
    feed);
  connectionRef.value = mobileConnection;
  return mobileConnection;
}

function createHubConnection(baseUrl: string, session: MobileApiSession): MobileHubConnection {
  const connection: HubConnection = new HubConnectionBuilder()
    .withUrl(new URL("/hubs/client", baseUrl).toString(), {
      accessTokenFactory: async () => {
        if (!session.accessTokenValue && !await session.refresh()) {
          throw new Error("A mobile access token is required for SignalR.");
        }
        const token = session.accessTokenValue;
        if (!token) {
          throw new Error("A mobile access token is required for SignalR.");
        }
        return token;
      }
    })
    .withAutomaticReconnect()
    .build();
  return connection;
}
