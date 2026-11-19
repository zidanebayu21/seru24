import { DeviceEventEmitter, NativeModules, PermissionsAndroid, Platform, type Permission } from 'react-native';
import { addToNearbyInbox } from '../../../web/shared/nearby-core';
import type { ChatMessage } from '../../../web/shared/e2ee-core';
import { account, readSetting, writeSetting } from './core';

// Siaran Dekat: transport Nearby Connections (Android) dan kotak masuk pesan kontak yang diterima langsung. Modul native
// hanya mengangkut byte; logika siapa boleh tersambung ada di radar.ts. Pesan kontak yang diterima disimpan (Keystore HP)
// sampai server mengirim salinan yang sama (client_msg_id sama), lalu digantikan oleh salinan server.

interface NativeNearbyModule {
  start: (name: string) => Promise<void>;
  request: (endpointId: string) => Promise<void>;
  acceptEndpoint: (endpointId: string) => void;
  rejectEndpoint: (endpointId: string) => void;
  disconnect: (endpointId: string) => void;
  send: (endpointId: string, json: string) => Promise<void>;
  stop: () => Promise<void>;
}

const EVENT = 'seru24NearbyEvent';
const native = NativeModules.Seru24Nearby as NativeNearbyModule | undefined;

export const nearbySupported = Platform.OS === 'android' && Boolean(native);

export interface NearbyEvent {
  type: 'found' | 'lost' | 'incoming' | 'connected' | 'failed' | 'disconnected' | 'payload' | 'state';
  id: string;
  value: string;
}

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

export const startNearby = (name: string) => native!.start(name);
export const stopNearby = () => native?.stop().catch(() => undefined) ?? Promise.resolve();
export const requestNearby = (endpointId: string) => native!.request(endpointId);
export const acceptNearby = (endpointId: string) => native?.acceptEndpoint(endpointId);
export const rejectNearby = (endpointId: string) => native?.rejectEndpoint(endpointId);
export const disconnectNearby = (endpointId: string) => native?.disconnect(endpointId);
export const sendNearby = (endpointId: string, json: string) => native!.send(endpointId, json);

export const onNearbyEvent = (listener: (event: NearbyEvent) => void) => {
  const sub = DeviceEventEmitter.addListener(EVENT, listener);
  return () => sub.remove();
};

// ---- kotak masuk: pesan kontak yang diterima langsung dan belum ada di server ----
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
