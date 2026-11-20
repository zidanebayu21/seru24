// Adaptor WebRTC Android (react-native-webrtc) untuk call-core bersama web.
import { PermissionsAndroid, Platform } from 'react-native';
import { mediaDevices, RTCPeerConnection } from 'react-native-webrtc';
import type { IceServer, MicStream, PeerLike } from '../../../web/shared/call-core';

export const getMobileMic = async (): Promise<MicStream> => {
  if (Platform.OS === 'android') {
    const result = await PermissionsAndroid.request(PermissionsAndroid.PERMISSIONS.RECORD_AUDIO);
    if (result !== PermissionsAndroid.RESULTS.GRANTED) throw new Error('mic-denied');
  }
  return (await mediaDevices.getUserMedia({ audio: true, video: false })) as unknown as MicStream;
};

export const createMobilePeer = (config: { iceServers: IceServer[] }): PeerLike =>
  new RTCPeerConnection(config) as unknown as PeerLike;
