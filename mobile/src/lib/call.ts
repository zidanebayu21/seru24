// Adaptor WebRTC Android (react-native-webrtc) untuk call-core bersama web.
import { NativeModules, PermissionsAndroid, Platform } from 'react-native';
import { mediaDevices, RTCPeerConnection } from 'react-native-webrtc';
import type { IceServer, MicStream, PeerLike } from '../../../web/shared/call-core';

export const getMobileMic = async (): Promise<MicStream> => {
  if (Platform.OS === 'android') {
    const result = await PermissionsAndroid.request(PermissionsAndroid.PERMISSIONS.RECORD_AUDIO);
    if (result !== PermissionsAndroid.RESULTS.GRANTED) throw new Error('mic-denied');
  }
  return (await mediaDevices.getUserMedia({ audio: true, video: false })) as unknown as MicStream;
};

interface NativeCallAudio {
  begin: () => void;
  setSpeaker: (on: boolean) => void;
  end: () => void;
}

const nativeAudio = NativeModules.Seru24CallAudio as NativeCallAudio | undefined;

/** Jalur audio panggilan (modul native Seru24CallAudio): earpiece bawaan, loudspeaker lewat setSpeaker. */
export const callAudio = {
  begin: () => nativeAudio?.begin(),
  setSpeaker: (on: boolean) => nativeAudio?.setSpeaker(on),
  end: () => nativeAudio?.end(),
};

export const createMobilePeer = (config: { iceServers: IceServer[] }): PeerLike =>
  new RTCPeerConnection(config) as unknown as PeerLike;
