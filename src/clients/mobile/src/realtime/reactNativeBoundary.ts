import { mediaDevices, RTCPeerConnection } from "react-native-webrtc";
import type { NativeWebRTCBoundary } from "./ReactNativeWebRTCTransport";

/**
 * The only production bridge from the transport to react-native-webrtc.
 * Browser-global registration is intentionally not used: the mobile transport
 * owns its native objects and the browser transport remains Desktop-only.
 */
export function createReactNativeWebRTCBoundary(
  fetcher: typeof fetch = fetch
): NativeWebRTCBoundary {
  return {
    createPeerConnection: () => new RTCPeerConnection({}) as unknown as ReturnType<NativeWebRTCBoundary["createPeerConnection"]>,
    getUserMedia: async () => mediaDevices.getUserMedia({ audio: true }) as unknown as Awaited<ReturnType<NativeWebRTCBoundary["getUserMedia"]>>,
    postSdp: async (url, init) => {
      const response = await fetcher(url, {
        method: "POST",
        body: init.body,
        headers: init.headers
      });
      return response;
    }
  };
}
