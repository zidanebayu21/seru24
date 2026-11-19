// Mode standby: koneksi realtime tetap hidup saat aplikasi di latar belakang, supaya jumlah belum dibaca dan cuplikan
// pesan sudah benar begitu daftar chat dibuka. Lebih boros baterai, jadi default mati.

import { AppState } from 'react-native';
import { readSetting, setRealtimeActive, writeSetting } from './core';

const SETTING = 'standby';
let standby = false;

export const isStandby = () => standby;

export const loadStandby = async () => {
  standby = (await readSetting(SETTING)) === 'on';
  return standby;
};

export const setStandby = async (on: boolean) => {
  standby = on;
  await writeSetting(SETTING, on ? 'on' : 'off');
  // dimatikan saat aplikasi sedang di latar belakang: putus sekarang; dinyalakan: pastikan tersambung
  if (on) setRealtimeActive(true);
  else if (AppState.currentState !== 'active') setRealtimeActive(false);
};
