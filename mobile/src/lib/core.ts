// Sambungan modul bersama (../web/shared) ke platform mobile: Android Keystore, fetch, Supabase.

import { Platform } from 'react-native';
import * as Keychain from 'react-native-keychain';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { fromBase64, toBase64, type SecretKeyring } from '../../../web/shared/crypto';
import { SecureFetchError, createSecureFetch } from '../../../web/shared/secure-fetch-core';
import { createSessionCore } from '../../../web/shared/session-core';
import { createAccountCore, type AccountState, type AccountStatus } from '../../../web/shared/account-core';
import { createE2ee } from '../../../web/shared/e2ee-core';
import { createInbox } from '../../../web/shared/inbox-core';
import type { Conversation } from '../../../web/shared/chat-core';
import { API_BASE_URL, SUPABASE_ANON_KEY, SUPABASE_URL } from '../env';
import { installNativeScrypt } from './nativeScrypt';

// ---- Penyimpanan aman: Android Keystore / iOS Keychain (OWASP MASVS-STORAGE) ----

const SECURE_OPTIONS = { accessible: Keychain.ACCESSIBLE.WHEN_UNLOCKED_THIS_DEVICE_ONLY };
const VISITOR_SERVICE = 'seru24.visitor';
const keyringService = (userId: string) => `seru24.keyring.${userId}`;

const readSecure = async (service: string) => {
  const result = await Keychain.getGenericPassword({ service });
  return result ? result.password : null;
};

const writeSecure = async (service: string, value: string) => {
  await Keychain.setGenericPassword('seru24', value, { service, ...SECURE_OPTIONS });
};

const removeSecure = (service: string) => Keychain.resetGenericPassword({ service });

const encodeKeyring = (ring: SecretKeyring) =>
  JSON.stringify(Object.fromEntries(Object.entries(ring).map(([v, k]) => [v, toBase64(k)])));

const decodeKeyring = (raw: string): SecretKeyring =>
  Object.fromEntries(Object.entries(JSON.parse(raw) as Record<string, string>).map(([v, k]) => [v, fromBase64(k)]));

// ---- Penanda perangkat (header x-visitor-key; server hanya menyimpan hash-nya) ----

let visitorKey = '';

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
export const session = createSessionCore(secureFetch, (wrapKey, salt) => accountCore?.setPendingKeyMaterial(wrapKey, salt));

let supabase: SupabaseClient | null = null;
const getSupabase = () => {
  supabase ??= createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    accessToken: session.getAccessToken,
    global: { headers: { 'x-visitor-key': visitorKey } },
  });
  return supabase;
};

export const rpc = async <T = unknown>(fn: string, args?: Record<string, unknown>): Promise<T> => {
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

export const e2ee = createE2ee({
  rpc,
  getKeyring: () => accountApi.getKeyring(),
  getMe: () => account.me,
  tofu: {
    get: readSecure,
    set: writeSecure,
  },
});

export const inbox = createInbox(getSupabase, () => account.me?.id);

export const listConversations = () => rpc<Conversation[]>('seru24_list_conversations');

/** Saat aplikasi dibuka: pulihkan sesi (cookie refresh) dan kunci chat dari Keystore. */
export const restoreSession = async (): Promise<AccountStatus> => {
  await Promise.all([loadVisitorKey(), installNativeScrypt()]);
  if (!(await session.getAccessToken())) return 'unknown';
  try {
    const status = await accountApi.bootstrapAccount(false);
    if (status !== 'ready') await signOut();
    return status;
  } catch {
    await signOut();
    return 'unknown';
  }
};

/** Setelah login/daftar: kunci chat dibuat atau dipulihkan dengan wrap_key dari password. */
export const finishSignIn = async () => {
  if ((await accountApi.bootstrapAccount(true)) !== 'ready') throw new Error('Kunci chat tidak bisa dibuka');
};

export const signOut = async () => {
  inbox.closeInbox();
  await accountApi.resetAccount();
  e2ee.resetE2ee();
  await session.logoutSession();
};

export const webUrl = (path: string) => `${API_BASE_URL}${path}`;
