import { MobileApiError } from "./MobileApiSession";

export type MobileLogoutRuntime = {
  revoke: () => Promise<void>;
  stopVoice: () => Promise<void>;
  disconnectSignalR: () => Promise<void>;
  clearFeed: () => void | Promise<void>;
  clearCredentials: () => Promise<void>;
};

/** Coordinates explicit mobile logout/revocation and local state teardown. */
export class MobileLogoutCoordinator {
  private logoutPromise: Promise<void> | undefined;

  public constructor(private readonly runtime: MobileLogoutRuntime) {}

  public logout(): Promise<void> {
    this.logoutPromise ??= this.executeLogout().catch(error => {
      this.logoutPromise = undefined;
      throw error;
    });
    return this.logoutPromise;
  }

  private async executeLogout(): Promise<void> {
    let revokeError: unknown;
    try {
      await this.runtime.revoke();
    } catch (error) {
      // Local teardown is still mandatory if the server already revoked the
      // session or the network is unavailable.
      revokeError = error;
    }

    let cleanupError: unknown;
    const cleanups = [
      this.runtime.stopVoice,
      this.runtime.disconnectSignalR,
      this.runtime.clearFeed
    ];
    if (!revokeError || isTerminalRevokeFailure(revokeError)) {
      cleanups.push(this.runtime.clearCredentials);
    }
    for (const cleanup of cleanups) {
      try {
        await cleanup();
      } catch (error) {
        cleanupError ??= error;
      }
    }

    if (revokeError && !isTerminalRevokeFailure(revokeError)) {
      throw revokeError;
    }
    if (cleanupError) {
      throw cleanupError;
    }
  }
}

function isTerminalRevokeFailure(error: unknown): boolean {
  return error instanceof MobileApiError && (error.status === 401 || error.status === 404);
}
