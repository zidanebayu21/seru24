// Sambungan modul bersama (../web/shared) ke platform mobile: Android Keystore, fetch, Supabase.

import { Platform } from 'react-native';
import * as Keychain from 'react-native-keychain';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { fromBase64, toBase64, type SecretKeyring } from '../../../web/shared/crypto';
import { SecureFetchError, createSecureFetch } from '../../../web/shared/secure-fetch-core';
import { createSessionCore, isNetworkError } from '../../../web/shared/session-core';
import { createAccountCore, type AccountState, type AccountStatus, type Me } from '../../../web/shared/account-core';
import { createE2ee } from '../../../web/shared/e2ee-core';
import { createInbox } from '../../../web/shared/inbox-core';
import { createConversationPresence, type PeerPresence } from '../../../web/shared/presence-core';
import { listConversationsArgs, type Conversation, type ListConversationsOptions } from '../../../web/shared/chat-core';
import { API_BASE_URL, REALTIME_PRESENCE, SUPABASE_ANON_KEY, SUPABASE_URL } from '../env';
import { installNativeScrypt } from './nativeScrypt';

// ---- Penyimpanan aman: Android Keystore / iOS Keychain (OWASP MASVS-STORAGE) ----

const SECURE_OPTIONS = { accessible: Keychain.ACCESSIBLE.WHEN_UNLOCKED_THIS_DEVICE_ONLY };
const VISITOR_SERVICE = 'seru24.visitor';
const keyringService = (userId: string) => `seru24.keyring.${userId}`;

export const readSecure = async (service: string) => {
  const result = await Keychain.getGenericPassword({ service });
  return result ? result.password : null;
};

export const writeSecure = async (service: string, value: string) => {
  await Keychain.setGenericPassword('seru24', value, { service, ...SECURE_OPTIONS });
};

export const removeSecure = (service: string) => Keychain.resetGenericPassword({ service });

const encodeKeyring = (ring: SecretKeyring) =>
  JSON.stringify(Object.fromEntries(Object.entries(ring).map(([v, k]) => [v, toBase64(k)])));

const decodeKeyring = (raw: string): SecretKeyring =>
  Object.fromEntries(Object.entries(JSON.parse(raw) as Record<string, string>).map(([v, k]) => [v, fromBase64(k)]));

// ---- Penanda perangkat (header x-visitor-key; server hanya menyimpan hash-nya) ----

let visitorKey = '';
let visitorReady: Promise<void> | null = null;

const loadVisitorKey = async () => {
  const stored = await readSecure(VISITOR_SERVICE);
  if (stored && /^[0-9a-f]{64}$/.test(stored)) {
    visitorKey = stored;
    return;
  }
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  visitorKey = Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
  await writeSecure(VISITOR_SERVICE, visitorKey);
};

/**
 * Kunci perangkat dibaca sekali dari Keystore; semua RPC menunggu ini selesai. Tanpa ini, daftar chat dari cache
 * (yang tampil sebelum sesi pulih) bisa memanggil server dengan header kosong lalu dianggap gagal dan logout.
 */
const ensureVisitorKey = () => {
  visitorReady ??= loadVisitorKey().catch(error => {
    visitorReady = null;
    throw error;
  });
  return visitorReady;
};

// ---- HTTP ke server Nuxt (payload terenkripsi transport) ----

export const secureFetch = createSecureFetch({
  getJson: async path => {
    const res = await fetch(`${API_BASE_URL}${path}`);
    if (!res.ok) throw new SecureFetchError(res.status, null);
    return res.json();
  },
  postText: async (path, body) => {
    // aplikasi native tidak mengirim Origin sendiri; server memeriksanya (pengaman CSRF untuk browser)
    const res = await fetch(`${API_BASE_URL}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'text/plain', origin: API_BASE_URL },
      body,
    });
    return { status: res.status, text: await res.text() };
  },
});

// ---- Modul bersama ----

export const account: AccountState = { me: null, status: 'unknown' };

let accountCore: ReturnType<typeof createAccountCore> | null = null;
// Refresh token juga disimpan di Keystore: cookie bisa hilang saat aplikasi diperbarui atau ditutup paksa.
const REFRESH_SERVICE = 'seru24.refresh';

export const session = createSessionCore(secureFetch, (wrapKey, salt) => accountCore?.setPendingKeyMaterial(wrapKey, salt), {
  load: () => readSecure(REFRESH_SERVICE),
  save: token => writeSecure(REFRESH_SERVICE, token),
  clear: async () => {
    await removeSecure(REFRESH_SERVICE);
  },
});

let supabase: SupabaseClient | null = null;
const getSupabase = () => {
  supabase ??= createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    accessToken: session.getAccessToken,
    // header dibaca saat setiap request dikirim (bukan saat klien dibuat), jadi selalu berisi kunci terbaru
    global: {
      fetch: (input, init) => {
        const headers = new Headers(init?.headers);
        if (visitorKey) headers.set('x-visitor-key', visitorKey);
        return fetch(input, { ...init, headers });
      },
    },
  });
  return supabase;
};

export const rpc = async <T = unknown>(fn: string, args?: Record<string, unknown>): Promise<T> => {
  await ensureVisitorKey();
  const { data, error } = await getSupabase().rpc(fn, args);
  if (error) throw error;
  return data as T;
};

accountCore = createAccountCore(
  {
    rpc,
    keyStore: {
      load: async userId => {
        const raw = await readSecure(keyringService(userId));
        return raw ? decodeKeyring(raw) : null;
      },
      save: (userId, ring) => writeSecure(keyringService(userId), encodeKeyring(ring)),
      remove: userId => removeSecure(keyringService(userId)),
    },
    platform: Platform.OS === 'ios' ? 'ios' : 'android',
    deviceName: () => `${Platform.OS === 'ios' ? 'iPhone' : 'Android'} ${String(Platform.Version)}`,
  },
  account,
);

const accountApi = accountCore;

export const getKeyring = () => accountApi.getKeyring();

export const e2ee = createE2ee({
  rpc,
  getKeyring: () => accountApi.getKeyring(),
  getMe: () => account.me,
  tofu: {
    get: readSecure,
    set: writeSecure,
  },
  // kunci publik lawan disimpan di HP agar chat tetap terbaca & pesan bisa diantrekan saat offline
  publicKeyCache: {
    get: userId => readSecure(`seru24.pubkeys.${userId}`),
    set: (userId, value) => writeSecure(`seru24.pubkeys.${userId}`, value),
  },
});

// ---- Status koneksi (offline = sesi belum bisa dipulihkan karena jaringan; data dari cache) ----

let online = true;
const onlineListeners = new Set<(value: boolean) => void>();

export const isOnline = () => online;
const setOnline = (value: boolean) => {
  if (online === value) return;
  online = value;
  for (const listener of onlineListeners) listener(value);
};
export const onOnlineChange = (listener: (value: boolean) => void) => {
  onlineListeners.add(listener);
  return () => {
    onlineListeners.delete(listener);
  };
};

export const inbox = createInbox(getSupabase, () => account.me?.id);

/** Status online & mengetik lawan di percakapan ini; null bila dimatikan lewat REALTIME_PRESENCE=false. */
export const openConversationPresence = (conversationId: string, onChange: (state: PeerPresence) => void) =>
  REALTIME_PRESENCE && account.me?.id
    ? createConversationPresence(getSupabase(), conversationId, account.me.id, onChange)
    : null;

export const listConversations = (options?: ListConversationsOptions) =>
  rpc<Conversation[]>('seru24_list_conversations', listConversationsArgs(options));

/** Hapus dokumen milik sendiri di server dan Google Drive (dipanggil sebelum pesannya dihapus). */
export const deleteRemoteFile = async (id: string) => {
  const token = await session.getAccessToken();
  if (token) await secureFetch('/api/files/delete', { access_token: token, id });
};

// Profil terakhir yang berhasil masuk (id, username, nama; bukan rahasia) agar daftar chat dari cache lokal
// bisa langsung tampil saat aplikasi dibuka, sementara sesi dipulihkan di belakang.
const LAST_ME_SERVICE = 'seru24.last_me';

/** offline = belum bisa menghubungi server; cache chat dan kunci di HP tetap bisa dipakai. */
export type RestoreStatus = AccountStatus | 'offline';
let accountReady: Promise<RestoreStatus> | null = null;

const rememberAccount = () =>
  account.me ? writeSecure(LAST_ME_SERVICE, JSON.stringify(account.me)).catch(() => undefined) : undefined;
const forgetCachedAccount = () => removeSecure(LAST_ME_SERVICE).catch(() => undefined);

/** true = ada profil tersimpan dan account.me sudah diisi darinya (status tetap 'unknown' sampai sesi pulih). */
export const loadCachedAccount = async (): Promise<boolean> => {
  const raw = await readSecure(LAST_ME_SERVICE).catch(() => null);
  if (!raw) return false;
  try {
    const me = JSON.parse(raw) as Me;
    if (typeof me?.id !== 'string') return false;
    account.me = me;
    return true;
  } catch {
    return false;
  }
};

/** Jaringan gagal: tetap masuk dengan profil + kunci di HP (tidak logout); sesi dicoba lagi nanti. */
const goOffline = async (): Promise<RestoreStatus> => {
  const me = account.me;
  if (me && (await accountApi.loadOfflineKeys(me))) {
    setOnline(false);
    return 'offline';
  }
  return 'unknown';
};

const restoreSessionNow = async (): Promise<RestoreStatus> => {
  await Promise.all([ensureVisitorKey(), installNativeScrypt()]);
  if (!(await session.getAccessToken())) {
    if (session.wasOffline()) return goOffline();
    await forgetCachedAccount();
    return 'unknown';
  }
  try {
    const status = await accountApi.bootstrapAccount(false, account.me?.id);
    if (status !== 'ready') await signOut();
    else {
      await rememberAccount();
      setOnline(true);
    }
    return status;
  } catch (error) {
    // hanya penolakan dari server yang membuat logout; sinyal hilang tidak
    if (isNetworkError(error)) return goOffline();
    await signOut();
    return 'unknown';
  }
};

/** Saat aplikasi dibuka: pulihkan sesi (cookie refresh) dan kunci chat dari Keystore. */
export const restoreSession = (): Promise<RestoreStatus> => {
  accountReady = restoreSessionNow();
  return accountReady;
};

/** Tunggu sesi dan kunci chat siap (layar chat memakainya sebelum mendekripsi pesan). */
export const whenAccountReady = (): Promise<RestoreStatus> => accountReady ?? Promise.resolve(account.status);

/** Setelah login/daftar: kunci chat dibuat atau dipulihkan dengan wrap_key dari password. */
export const finishSignIn = async () => {
  if ((await accountApi.bootstrapAccount(true)) !== 'ready') throw new Error('Kunci chat tidak bisa dibuka');
  accountReady = Promise.resolve('ready');
  setOnline(true);
  await rememberAccount();
};

const signOutCleanups = new Set<() => Promise<void>>();
export const onBeforeSignOut = (fn: () => Promise<void>) => {
  signOutCleanups.add(fn);
  return () => signOutCleanups.delete(fn);
};

/** Hemat daya: koneksi realtime diputus saat app di latar belakang (notifikasi lewat FCM) dan disambung lagi saat dibuka. */
export const setRealtimeActive = (active: boolean) => {
  if (!account.me) return;
  const realtime = getSupabase().realtime;
  if (active) realtime.connect();
  else realtime.disconnect().catch(() => undefined);
};

export const signOut = async () => {
  for (const cleanup of signOutCleanups) {
    await cleanup().catch(() => undefined);
  }
  inbox.closeInbox();
  accountReady = null;
  await forgetCachedAccount();
  await accountApi.resetAccount();
  e2ee.resetE2ee();
  await session.logoutSession();
};

export const webUrl = (path: string) => `${API_BASE_URL}${path}`;

/** Pengaturan kecil per perangkat (mis. notifikasi), disimpan di Keystore. */
export const readSetting = (name: string) => readSecure(`seru24.setting.${name}`).catch(() => null);
export const writeSetting = (name: string, value: string) => writeSecure(`seru24.setting.${name}`, value).catch(() => undefined);
