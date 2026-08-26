import type { AudioRoute, NativeAudioRouteBoundary } from "./MobileAudioRoute";

export type InCallAudioManager = {
  start: (setup?: { media?: "audio" | "video" }) => void;
  stop: (setup?: { busytone?: string }) => void;
  setForceSpeakerphoneOn: (flag: boolean | null) => void;
  getIsWiredHeadsetPluggedIn?: () => Promise<{ isWiredHeadsetPluggedIn: boolean }>;
};

export type NativeAudioEventEmitter = {
  addListener: (eventName: string, listener: (payload: unknown) => void) => { remove: () => void };
};

export type InCallAudioRouteDependencies = {
  inCallManager: InCallAudioManager;
  deviceEventEmitter: NativeAudioEventEmitter;
  requestMicrophonePermission: () => Promise<"granted" | "denied">;
};

/**
 * Adapts the cross-platform react-native-incall-manager API to Jarvis's audio
 * seam. Policy calls are deliberately not treated as route observations:
 * only native headset/noisy events (or the wired-headset query) update the
 * observed route, and otherwise the UI sees "unknown".
 */
export function createInCallAudioRouteBoundary(
  dependencies: InCallAudioRouteDependencies
): NativeAudioRouteBoundary {
  let observedRoute: AudioRoute = "unknown";
  let active = false;
  let lifecycle = 0;
  let nativeSubscriptions: { remove: () => void }[] = [];
  const listeners = new Set<(route: AudioRoute) => void>();

  const publishObservedRoute = (route: AudioRoute): void => {
    if (observedRoute === route) {
      return;
    }
    observedRoute = route;
    for (const listener of listeners) {
      listener(route);
    }
  };

  const removeNativeSubscriptions = (): void => {
    for (const subscription of nativeSubscriptions) {
      subscription.remove();
    }
    nativeSubscriptions = [];
  };

  const subscribeNativeRoutes = (): void => {
    nativeSubscriptions = [
      dependencies.deviceEventEmitter.addListener("WiredHeadset", payload => {
        const isPlugged = typeof payload === "object" && payload !== null &&
          (payload as { isPlugged?: unknown }).isPlugged === true;
        publishObservedRoute(isPlugged ? "headset" : "unknown");
      }),
      dependencies.deviceEventEmitter.addListener("NoisyAudio", () => {
        // A noisy-audio event means the previous route may no longer exist;
        // the manager does not expose a reliable replacement route query.
        publishObservedRoute("unknown");
      })
    ];
  };

  return {
    requestMicrophonePermission: dependencies.requestMicrophonePermission,
    startCallAudio: async () => {
      if (active) {
        return;
      }
      dependencies.inCallManager.start({ media: "audio" });
      active = true;
      const currentLifecycle = ++lifecycle;
      subscribeNativeRoutes();
      const getWiredHeadset = dependencies.inCallManager.getIsWiredHeadsetPluggedIn;
      if (getWiredHeadset) {
        try {
          const result = await getWiredHeadset.call(dependencies.inCallManager);
          if (active && lifecycle === currentLifecycle) {
            publishObservedRoute(result.isWiredHeadsetPluggedIn ? "headset" : "unknown");
          }
        } catch {
          // Route observation remains unknown when the native query is unavailable.
        }
      }
    },
    stopCallAudio: async () => {
      if (!active) {
        return;
      }
      active = false;
      ++lifecycle;
      removeNativeSubscriptions();
      dependencies.inCallManager.stop();
      publishObservedRoute("unknown");
    },
    getOutputRoute: () => observedRoute,
    setOutputRoute: async route => {
      // null asks the library to restore its platform default. Neither this
      // call nor a successful return value establishes the physical route.
      dependencies.inCallManager.setForceSpeakerphoneOn(route === "speaker" ? true : null);
      return observedRoute;
    },
    subscribeOutputRoute: listener => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    }
  };
}
