import { useCallback, useEffect, useRef, useState } from 'react';
import { randomId } from '../../../web/shared/crypto';
import { createCallController, type CallEndReason, type CallPhase, type CallSignal } from '../../../web/shared/call-core';
import { callQualityOption, nextCallQuality, parseCallQuality, type CallQuality } from '../../../web/shared/call-quality-core';
import { account, readSetting, writeSetting } from './core';
import { callAudio, createMobilePeer, getMobileMic } from './call';

export const CALL_END_TEXT: Record<CallEndReason, string> = {
  hangup: 'Panggilan selesai',
  rejected: 'Panggilan ditolak',
  busy: 'Lawan bicara sedang dalam panggilan lain',
  timeout: 'Panggilan tidak dijawab',
  failed: 'Panggilan gagal tersambung (jaringan mungkin memblokir sambungan langsung)',
  'mic-denied': 'Izin mikrofon ditolak',
};
const CALL_NOTE_MS = 5000;

type SignalSender = { sendCallSignal: (signal: CallSignal) => void } | null;

/** Telepon suara untuk satu percakapan; sinyal lewat presence (channel conv:<id>) yang dibuka layar chat. */
export const useVoiceCall = (presenceRef: { current: SignalSender }, conversationId: string) => {
  const [phase, setPhase] = useState<CallPhase>('idle');
  const [note, setNote] = useState('');
  const [muted, setMuted] = useState(false);
  const [speaker, setSpeaker] = useState(false);
  const [peerRecording, setPeerRecording] = useState(false);
  // kualitas suara dipilih per percakapan; dibaca controller lewat ref saat panggilan tersambung
  const [quality, setQuality] = useState<CallQuality>('standar');
  const qualityRef = useRef<CallQuality>('standar');
  const settingName = `call-quality.${conversationId}`;
  const controller = useRef<ReturnType<typeof createCallController> | null>(null);
  const noteTimer = useRef<ReturnType<typeof setTimeout>>(undefined);

  const get = useCallback(() => {
    controller.current ??= createCallController({
      myId: account.me?.id ?? '',
      send: signal => presenceRef.current?.sendCallSignal(signal),
      onPhase: next => {
        setPhase(next);
        if (next === 'idle') {
          setMuted(false);
          setSpeaker(false);
        } else {
          setNote('');
        }
        // mode komunikasi dipasang begitu panggilan benar-benar berjalan dan dilepas saat selesai
        if (next === 'connecting') callAudio.begin();
        else if (next === 'idle') callAudio.end();
      },
      onRemoteStream: () => undefined, // react-native-webrtc memutar audio lawan otomatis
      onPeerRecording: setPeerRecording,
      onEnd: reason => {
        setNote(CALL_END_TEXT[reason]);
        clearTimeout(noteTimer.current);
        noteTimer.current = setTimeout(() => setNote(''), CALL_NOTE_MS);
      },
      newCallId: randomId,
      getBitrate: () => callQualityOption(qualityRef.current).bitrate,
      getMic: getMobileMic,
      createPeer: createMobilePeer,
    });
    return controller.current;
  }, [presenceRef]);

  useEffect(() => {
    let alive = true;
    readSetting(settingName).then(raw => {
      if (!alive) return;
      qualityRef.current = parseCallQuality(raw);
      setQuality(qualityRef.current);
    });
    return () => {
      alive = false;
    };
  }, [settingName]);

  useEffect(() => () => {
    controller.current?.hangup();
    clearTimeout(noteTimer.current);
  }, []);

  return {
    phase,
    note,
    muted,
    speaker,
    peerRecording,
    quality,
    onSignal: useCallback((signal: CallSignal) => { void get().handleSignal(signal); }, [get]),
    start: () => { void get().start(); },
    accept: () => { void get().accept(); },
    reject: () => get().reject(),
    hangup: () => get().hangup(),
    toggleMute: () => setMuted(get().setMuted(!muted)),
    /** Ganti ke kualitas berikutnya (berputar); berlaku di panggilan berikutnya. */
    cycleQuality: () => {
      if (phase !== 'idle') return;
      qualityRef.current = nextCallQuality(qualityRef.current);
      setQuality(qualityRef.current);
      writeSetting(settingName, qualityRef.current).catch(() => undefined);
    },
    toggleSpeaker: () => {
      callAudio.setSpeaker(!speaker);
      setSpeaker(!speaker);
    },
  };
};

export type VoiceCall = ReturnType<typeof useVoiceCall>;
