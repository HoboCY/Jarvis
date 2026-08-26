export class VoiceSessionCancelledError extends Error {
  public constructor(message = "Voice startup was cancelled because the app is not active.") {
    super(message);
    this.name = "VoiceSessionCancelledError";
  }
}

type Cleanup = () => void | Promise<void>;

export type VoiceSessionAttempt = {
  checkpoint: () => void;
  adopt: (cleanup: Cleanup) => void;
  commit: () => void;
};

type AttemptState = {
  epoch: number;
  cancelled: boolean;
  committed: boolean;
  cleanups: Cleanup[];
  cleanupPromise?: Promise<void>;
};

/**
 * Owns the foreground epoch for voice startup and its native resources.
 * Callers must checkpoint after every awaited external/native operation and
 * adopt each resource as soon as it is created. A background transition then
 * invalidates the epoch and cleans both committed and late-created resources.
 */
export class VoiceSessionCoordinator {
  private foreground: boolean;
  private epoch = 0;
  private pendingAttempt: AttemptState | undefined;
  private activeCleanup: (() => Promise<void>) | undefined;
  private cleanupBarrier: Promise<void> = Promise.resolve();

  public constructor(initialForeground = true) {
    this.foreground = initialForeground;
  }

  public get hasActiveSession(): boolean {
    return this.activeCleanup !== undefined || this.pendingAttempt?.committed === true;
  }

  public get isForeground(): boolean {
    return this.foreground;
  }

  public setForeground(isForeground: boolean): void {
    if (this.foreground === isForeground) {
      return;
    }
    this.foreground = isForeground;
    if (!isForeground) {
      void this.stop().catch(() => undefined);
    }
  }

  public async start(factory: (attempt: VoiceSessionAttempt) => Promise<void>): Promise<void> {
    await this.stop();
    if (!this.foreground) {
      throw new VoiceSessionCancelledError();
    }

    const state: AttemptState = {
      epoch: this.epoch,
      cancelled: false,
      committed: false,
      cleanups: []
    };
    this.pendingAttempt = state;
    const attempt = this.createAttempt(state);
    try {
      await factory(attempt);
      attempt.checkpoint();
      if (!state.committed) {
        throw new Error("Voice startup completed without committing a session.");
      }
      if (this.pendingAttempt === state) {
        this.pendingAttempt = undefined;
        this.activeCleanup = () => this.cleanup(state);
      }
    } catch (error) {
      if (this.pendingAttempt === state) {
        this.pendingAttempt = undefined;
      }
      await this.cleanup(state).catch(() => undefined);
      throw error;
    }
  }

  public async stop(): Promise<void> {
    ++this.epoch;
    const pending = this.pendingAttempt;
    this.pendingAttempt = undefined;
    if (pending) {
      pending.cancelled = true;
    }
    const activeCleanup = this.activeCleanup;
    this.activeCleanup = undefined;
    const cleanups: Promise<void>[] = [];
    if (pending) {
      cleanups.push(this.cleanup(pending));
    }
    if (activeCleanup) {
      cleanups.push(activeCleanup());
    }
    const runCleanup = async (): Promise<void> => {
      const results = await Promise.allSettled(cleanups);
      const failure = results.find(result => result.status === "rejected");
      if (failure?.status === "rejected") {
        throw failure.reason;
      }
    };
    const cleanup = this.cleanupBarrier.then(runCleanup, runCleanup);
    this.cleanupBarrier = cleanup;
    await cleanup;
  }

  private createAttempt(state: AttemptState): VoiceSessionAttempt {
    return {
      checkpoint: () => {
        if (state.cancelled || state.epoch !== this.epoch || !this.foreground) {
          throw new VoiceSessionCancelledError();
        }
      },
      adopt: cleanup => {
        if (state.cancelled || state.epoch !== this.epoch || !this.foreground) {
          void this.runCleanup(cleanup).catch(() => undefined);
          return;
        }
        state.cleanups.push(cleanup);
      },
      commit: () => {
        const attempt = this.createAttemptCheckpoint(state);
        attempt();
        state.committed = true;
      }
    };
  }

  private createAttemptCheckpoint(state: AttemptState): () => void {
    return () => {
      if (state.cancelled || state.epoch !== this.epoch || !this.foreground) {
        throw new VoiceSessionCancelledError();
      }
    };
  }

  private async cleanup(state: AttemptState): Promise<void> {
    if (state.cleanupPromise) {
      return state.cleanupPromise;
    }
    state.cancelled = true;
    state.cleanupPromise = (async () => {
      let firstError: unknown;
      for (const cleanup of [...state.cleanups].reverse()) {
        try {
          await this.runCleanup(cleanup);
        } catch (error) {
          firstError ??= error;
        }
      }
      if (firstError) {
        throw firstError;
      }
    })();
    return state.cleanupPromise;
  }

  private async runCleanup(cleanup: Cleanup): Promise<void> {
    await cleanup();
  }
}
