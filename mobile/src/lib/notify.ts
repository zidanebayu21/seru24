// Notifikasi "Pesan baru" di Android:
//  - Realtime saat aplikasi hidup (terbuka / di latar belakang)
//  - FCM (push) saat aplikasi ditutup penuh (butuh google-services.json + kredensial FCM di server)

import { AppState, DeviceEventEmitter, PermissionsAndroid, Platform, NativeModules, type EmitterSubscription } from 'react-native';
import { account, inbox, onBeforeSignOut, readSetting, rpc, secureFetch, session, writeSetting } from './core';

interface Seru24NotifyModule {
  show: (title: string, body: string, tag: string) => void;
  setEnabled: (enabled: boolean) => void;
  setPresence: (foreground: boolean, conversationId: string | null) => void;
  getFcmToken: () => Promise<string | null>;
}

const native = NativeModules.Seru24Notify as Seru24NotifyModule | undefined;
const SETTING = 'notifications';
const TOKEN_SETTING = 'fcm_token';
const EVENT_FCM_TOKEN = 'seru24:fcm_token';

export const notifySupported = Boolean(native);

let enabled = false;
let unsubscribeInbox: (() => void) | null = null;
let appStateSub: EmitterSubscription | null = null;
let tokenSub: EmitterSubscription | null = null;
let activeConversationGetter: (() => string | null) | null = null;

export const isNotifyEnabled = () => enabled;

const registerTokenOnServer = async (token: string) => {
  if (!token || (Platform.OS !== 'android' && Platform.OS !== 'ios')) return;
  await rpc('seru24_register_push_token', { p_platform: Platform.OS, p_token: token });
  await writeSetting(TOKEN_SETTING, token);
};

const unregisterTokenOnServer = async () => {
  const token = (await native?.getFcmToken().catch(() => null)) || (await readSetting(TOKEN_SETTING));
  if (!token) return;
  await rpc('seru24_unregister_push_token', { p_token: token }).catch(() => undefined);
  await writeSetting(TOKEN_SETTING, '');
};

const syncPushToken = async () => {
  if (!native || !enabled) return;
  const token = await native.getFcmToken().catch(() => null);
  if (token) await registerTokenOnServer(token).catch(() => undefined);
};

onBeforeSignOut(unregisterTokenOnServer);

export const loadNotifySetting = async () => {
  enabled = notifySupported && (await readSetting(SETTING)) === 'on';
  native?.setEnabled(enabled);
  if (enabled) await syncPushToken();
  return enabled;
};

/** Android 13+ wajib minta izin POST_NOTIFICATIONS; false bila pengguna menolak. */
export const enableNotifications = async () => {
  if (!notifySupported || !native) return false;
  if (Platform.OS === 'android' && Number(Platform.Version) >= 33) {
    const result = await PermissionsAndroid.request(PermissionsAndroid.PERMISSIONS.POST_NOTIFICATIONS);
    if (result !== PermissionsAndroid.RESULTS.GRANTED) return false;
  }
  enabled = true;
  native.setEnabled(true);
  await writeSetting(SETTING, 'on');
  await syncPushToken();
  return true;
};

export const disableNotifications = async () => {
  enabled = false;
  native?.setEnabled(false);
  await writeSetting(SETTING, 'off');
  await unregisterTokenOnServer();
};

export const updateNotificationPresence = (conversationId: string | null) => {
  native?.setPresence(AppState.currentState === 'active', conversationId);
};

/** activeConversation: percakapan yang sedang dibuka (tidak perlu notifikasi bila aplikasi aktif di sana). */
export const startNotifications = (activeConversation: () => string | null) => {
  if (unsubscribeInbox || !native) return;
  activeConversationGetter = activeConversation;
  updateNotificationPresence(activeConversation());

  appStateSub = AppState.addEventListener('change', state => {
    native.setPresence(state === 'active', activeConversationGetter?.() ?? null);
  });

  tokenSub = DeviceEventEmitter.addListener(EVENT_FCM_TOKEN, (token: string) => {
    if (enabled && token) registerTokenOnServer(token).catch(() => undefined);
  });

  unsubscribeInbox = inbox.onInbox((event, payload) => {
    if (event !== 'message_new' || !enabled || payload.sender_id === account.me?.id) return;
    const conversationId = String(payload.conversation_id);
    if (AppState.currentState === 'active' && activeConversation() === conversationId) return;
    native.show('seru24', 'Pesan baru', conversationId);
  });
};

export const stopNotifications = () => {
  unsubscribeInbox?.();
  unsubscribeInbox = null;
  appStateSub?.remove();
  appStateSub = null;
  tokenSub?.remove();
  tokenSub = null;
  activeConversationGetter = null;
  native?.setPresence(false, null);
};

/** Beri tahu server untuk mengirim push FCM ke perangkat penerima (best-effort). */
export const notifyMessageSent = (conversationId: string, messageId: string) => {
  session
    .getAccessToken()
    .then(token =>
      token ? secureFetch('/api/push/notify', { access_token: token, conversation_id: conversationId, message_id: messageId }) : undefined,
    )
    .catch(() => undefined);
};
