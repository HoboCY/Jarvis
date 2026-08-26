import { DeviceEventEmitter, PermissionsAndroid, Platform } from "react-native";
import InCallManager from "react-native-incall-manager";
import {
  createInCallAudioRouteBoundary,
  type InCallAudioManager,
  type NativeAudioEventEmitter
} from "./inCallAudioRouteBoundary";
import type { NativeAudioRouteBoundary } from "./MobileAudioRoute";

/**
 * Production React Native adapter for the cross-platform call audio policy.
 *
 * `react-native-incall-manager` owns the native audio session and route policy
 * on both platforms. This wrapper intentionally does not use react-native-
 * WebRTC's iOS-only audio-session API on Android. Physical route state is
 * still reported only from native route events/query results; a successful
 * policy call remains an observation of "unknown" until the OS tells us more.
 */
export function createReactNativeAudioRouteBoundary(): NativeAudioRouteBoundary {
  const inCallManager: InCallAudioManager = {
    start: setup => InCallManager.start(setup),
    stop: setup => InCallManager.stop(setup),
    setForceSpeakerphoneOn: (flag: boolean | null) => {
      // v4.2.1's declaration predates its documented null/auto behavior.
      const setForceSpeakerphoneOn = InCallManager.setForceSpeakerphoneOn as unknown as
        (value: boolean | null) => void;
      setForceSpeakerphoneOn.call(InCallManager, flag);
    },
    getIsWiredHeadsetPluggedIn: () => InCallManager.getIsWiredHeadsetPluggedIn()
  };
  const deviceEventEmitter = DeviceEventEmitter as unknown as NativeAudioEventEmitter;

  return createInCallAudioRouteBoundary({
    inCallManager,
    deviceEventEmitter,
    requestMicrophonePermission: async () => {
      if (Platform.OS !== "android") {
        // iOS presents its microphone prompt when the WebRTC media stream opens.
        return "granted";
      }
      const result = await PermissionsAndroid.request(PermissionsAndroid.PERMISSIONS.RECORD_AUDIO);
      return result === PermissionsAndroid.RESULTS.GRANTED ? "granted" : "denied";
    }
  });
}
