import { DeviceEventEmitter, NativeModules } from 'react-native';
import type { FileMessageBody } from '../../../web/shared/file-core';
import { downloadToCache } from './files';

// Pemutar pesan suara: berkas didekripsi ke cache privat lalu diputar MediaPlayer bawaan Android (modul native
// Seru24Audio). Berkas sementara dihapus modul native setelah selesai, dijeda lalu dihentikan, atau gagal.

export interface VoiceState {
  id: string;
  state: 'loading' | 'playing' | 'paused' | 'ended' | 'stopped' | 'error';
  positionMs: number;
  durationMs: number;
}

interface NativeAudioModule {
  play: (id: string, path: string) => Promise<void>;
  pause: () => void;
  resume: () => void;
  stop: () => void;
}

const native = NativeModules.Seru24Audio as NativeAudioModule | undefined;
const EVENT = 'seru24AudioState';

export const playVoice = async (file: FileMessageBody): Promise<void> => {
  if (!native) throw new Error('Pemutar suara tidak didukung di perangkat ini');
  const path = await downloadToCache(file);
  await native.play(file.id, path);
};

export const pauseVoice = () => native?.pause();
export const resumeVoice = () => native?.resume();
export const stopVoice = () => native?.stop();

/** Dengarkan status pemutar (memutar, jeda, selesai, gagal, posisi); mengembalikan fungsi untuk berhenti. */
export const onVoiceState = (listener: (state: VoiceState) => void): (() => void) => {
  const subscription = DeviceEventEmitter.addListener(EVENT, listener);
  return () => subscription.remove();
};
