type RemoteReceiver = { track: { kind: string; readyState: string } };
type ObservablePeerConnection = {
  connectionState: RTCPeerConnectionState;
  getReceivers: () => readonly RemoteReceiver[];
};

/** Uses the public WebRTC receiver surface; track IDs, SDP, and media are never inspected. */
export function projectPhase9bRealtimeConnection(
  realtimeSessionId: string,
  connection: ObservablePeerConnection | undefined
): {
  realtimeSessionId: string;
  peerConnectionState: RTCPeerConnectionState;
  remoteAudioTrackCount: number;
  liveRemoteAudioTrackCount: number;
} | undefined {
  if (connection === undefined) {
    return undefined;
  }
  const tracks = connection.getReceivers().map(receiver => receiver.track).filter(track => track.kind === "audio");
  return {
    realtimeSessionId,
    peerConnectionState: connection.connectionState,
    remoteAudioTrackCount: tracks.length,
    liveRemoteAudioTrackCount: tracks.filter(track => track.readyState === "live").length
  };
}
