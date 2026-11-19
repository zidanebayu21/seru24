import { DeviceEventEmitter, NativeModules, PermissionsAndroid, Platform, type Permission } from 'react-native';
import { addToNearbyInbox, parseNearbyWire, type NearbyWire } from '../../../web/shared/nearby-core';
import type { ChatMessage } from '../../../web/shared/e2ee-core';
import { account, readSetting, writeSetting } from './core';

// Mode Dekat: chat langsung antar HP tanpa internet (Nearby Connections, Android). Hanya amplop ciphertext E2EE yang
// lewat; modul native cuma mengangkut byte. Pesan yang diterima disimpan (Keystore HP) sampai server mengirim
// salinan yang sama (client_msg_id sama), lalu digantikan oleh salinan server.

export type NearbyState = 'off' | 'searching' | 'connecting' | 'connected' | 'error';

interface NativeNearbyModule {
  start: (localTag: string, peerTag: string) => Promise<void>;
  send: (json: string) => Promise<void>;
  stop: () => Promise<void>;
}

const EVENT = 'seru24NearbyEvent';
const native = NativeModules.Seru24Nearby as NativeNearbyModule | undefined;

export const nearbySupported = Platform.OS === 'android' && Boolean(native);

/** Izin runtime menurut versi Android: Bluetooth baru sejak 12 (API 31), Wi-Fi sekitar sejak 13 (API 33). */
const requiredPermissions = (): Permission[] => {
  const api = Number(Platform.Version);
  const list: string[] = [];
  if (api <= 31) list.push('android.permission.ACCESS_FINE_LOCATION');
  if (api >= 31) list.push('android.permission.BLUETOOTH_SCAN', 'android.permission.BLUETOOTH_ADVERTISE', 'android.permission.BLUETOOTH_CONNECT');
  if (api >= 33) list.push('android.permission.NEARBY_WIFI_DEVICES');
  return list as Permission[];
};

export const requestNearbyPermissions = async (): Promise<boolean> => {
  if (!nearbySupported) return false;
  const result = await PermissionsAndroid.requestMultiple(requiredPermissions());
  return Object.values(result).every(value => value === PermissionsAndroid.RESULTS.GRANTED);
};

export const startNearby = (localTag: string, peerTag: string) => native!.start(localTag, peerTag);
export const stopNearby = () => native?.stop().catch(() => undefined) ?? Promise.resolve();
export const sendNearby = (json: string) => native!.send(json);

type NativeEvent = { type: 'state' | 'payload'; value: string };

export const onNearbyState = (listener: (state: NearbyState) => void) => {
  const sub = DeviceEventEmitter.addListener(EVENT, (event: NativeEvent) => {
    if (event.type === 'state') listener(event.value as NearbyState);
  });
  return () => sub.remove();
};

export const onNearbyWire = (listener: (wire: NearbyWire) => void) => {
  const sub = DeviceEventEmitter.addListener(EVENT, (event: NativeEvent) => {
    if (event.type !== 'payload') return;
    const wire = parseNearbyWire(event.value);
    if (wire) listener(wire);
  });
  return () => sub.remove();
};

// ---- kotak masuk: pesan yang diterima langsung dan belum ada di server ----
const inboxKey = () => `nearbyInbox.${account.me?.id ?? ''}`;

const loadInbox = async (): Promise<ChatMessage[]> => {
  if (!account.me?.id) return [];
  try {
    const parsed: unknown = JSON.parse((await readSetting(inboxKey())) ?? '[]');
    return Array.isArray(parsed) ? (parsed as ChatMessage[]) : [];
  } catch {
    return [];
  }
};

export const saveNearbyReceived = async (message: ChatMessage) => {
  await writeSetting(inboxKey(), JSON.stringify(addToNearbyInbox(await loadInbox(), message)));
};

export const nearbyReceivedFor = async (conversationId: string) =>
  (await loadInbox()).filter(message => message.conversation_id === conversationId);

/** Buang pesan yang sudah ada salinannya dari server. */
export const dropNearbyReceived = async (clientMsgIds: string[]) => {
  if (clientMsgIds.length === 0) return;
  const drop = new Set(clientMsgIds);
  await writeSetting(inboxKey(), JSON.stringify((await loadInbox()).filter(message => !drop.has(message.client_msg_id))));
};
