import type { FoundUser, SendResult } from '../../../web/shared/chat-core';
import type { ChatMessage } from '../../../web/shared/e2ee-core';
import { account, e2ee, isOnline, listConversations, rpc, readSetting, writeSetting } from './core';
import { notifyMessageSent } from './notify';

// Obrolan Siaran Dekat dengan orang yang belum pernah chat. Disimpan di HP (Keystore) karena belum ada percakapan di
// server. Saat online, username menjadi patokan: percakapan dibuat lewat permintaan chat biasa, pesan milik kita disegel
// ulang dengan id percakapan asli (client_msg_id sama) lalu diunggah. Pesan lawan bicara tidak diunggah oleh kita;
// salinannya datang dari server setelah lawan bicara online.

export interface StrangerMessage {
  id: string;
  mine: boolean;
  text: string;
  createdAt: string;
  /** Pesan kita: sudah diterima HP lawan bicara (ack). */
  acked: boolean;
  /** Pesan kita: sudah tersimpan di server. */
  synced: boolean;
}

export interface StrangerSession {
  userId: string;
  username: string;
  keyVersion: number;
  publicKey: string;
  messages: StrangerMessage[];
  updatedAt: string;
  /** Username tidak cocok dengan id di server: tidak diunggah. */
  unverified?: boolean;
  /** Kunci yang diklaim saat bertemu berbeda dari kunci di server: waspada. */
  keyWarning?: boolean;
}

const MAX_MESSAGES = 200;
const MAX_SESSIONS = 50;
const storageKey = () => `strangers.${account.me?.id ?? ''}`;
const listeners = new Set<() => void>();
let syncing: Promise<void> | null = null;

export const onStrangersChange = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

export const loadStrangers = async (): Promise<StrangerSession[]> => {
  if (!account.me?.id) return [];
  try {
    const parsed: unknown = JSON.parse((await readSetting(storageKey())) ?? '[]');
    return Array.isArray(parsed) ? (parsed as StrangerSession[]) : [];
  } catch {
    return [];
  }
};

// Tulis berurutan: dua pembaruan hampir bersamaan (pesan masuk + ack) tidak boleh saling menimpa.
let writing: Promise<unknown> = Promise.resolve();
const update = (change: (sessions: StrangerSession[]) => StrangerSession[]): Promise<void> => {
  const run = writing.then(async () => {
    const next = change(await loadStrangers())
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .slice(0, MAX_SESSIONS);
    await writeSetting(storageKey(), JSON.stringify(next));
    for (const listener of listeners) listener();
  });
  writing = run.catch(() => undefined);
  return run;
};

export const upsertStranger = (identity: { userId: string; username: string; keyVersion: number; publicKey: string }) =>
  update(list => {
    const existing = list.find(s => s.userId === identity.userId);
    const session: StrangerSession = {
      ...existing,
      ...identity,
      messages: existing?.messages ?? [],
      updatedAt: new Date().toISOString(),
    };
    return [session, ...list.filter(s => s.userId !== identity.userId)];
  });

/** Tambah pesan tanpa duplikat (id sama diabaikan). */
export const addStrangerMessage = (userId: string, message: StrangerMessage) =>
  update(list =>
    list.map(s =>
      s.userId !== userId || s.messages.some(m => m.id === message.id)
        ? s
        : { ...s, updatedAt: new Date().toISOString(), messages: [...s.messages, message].slice(-MAX_MESSAGES) },
    ),
  );

export const markStrangerAcked = (clientMsgId: string) =>
  update(list => list.map(s => ({ ...s, messages: s.messages.map(m => (m.id === clientMsgId ? { ...m, acked: true } : m)) })));

export const removeStranger = (userId: string) => update(list => list.filter(s => s.userId !== userId));

const patchSession = (userId: string, patch: Partial<StrangerSession>) =>
  update(list => list.map(s => (s.userId === userId ? { ...s, ...patch } : s)));

const patchMessage = (userId: string, id: string, patch: Partial<StrangerMessage>) =>
  update(list =>
    list.map(s => (s.userId === userId ? { ...s, messages: s.messages.map(m => (m.id === id ? { ...m, ...patch } : m)) } : s)),
  );

/** Unggah pesan milik kita untuk satu sesi; true bila sesi ini sudah beres dan boleh dibuang dari HP. */
const syncSession = async (session: StrangerSession): Promise<boolean> => {
  const found = await rpc<FoundUser[]>('seru24_search_user', { p_username: session.username });
  if (found?.[0]?.id !== session.userId) {
    await patchSession(session.userId, { unverified: true });
    return false;
  }
  // Sesi yang hanya menerima pesan tidak membuat permintaan chat baru: tunggu percakapan dari lawan bicara muncul.
  let conversationId: string | undefined;
  if (session.messages.some(m => m.mine)) {
    const started = await rpc<{ ok: boolean; conversation_id?: string }>('seru24_start_direct_chat', { p_target: session.userId });
    conversationId = started?.ok ? started.conversation_id : undefined;
  } else {
    conversationId = (await listConversations()).find(c => c.peer_id === session.userId)?.id;
  }
  if (!conversationId) return false;

  const check = await e2ee.checkClaimedKey(session.userId, { key_version: session.keyVersion, public_key: session.publicKey, revoked: false });
  if (check === 'mismatch') await patchSession(session.userId, { keyWarning: true });

  for (const message of session.messages.filter(m => m.mine && !m.synced)) {
    // disegel ulang dengan kunci server dan id percakapan asli; client_msg_id sama supaya tidak ganda
    const params = await e2ee.encryptText(conversationId, session.userId, message.text, true, { clientMsgId: message.id });
    const result = await rpc<SendResult>('seru24_send_message', params);
    if (!result.ok) return false;
    await patchMessage(session.userId, message.id, { synced: true });
    if (result.id && result.code !== 'duplicate') notifyMessageSent(conversationId, result.id);
  }

  // pesan lawan bicara baru aman dibuang dari HP setelah salinan servernya ada
  const onServer = new Set(
    (await rpc<ChatMessage[]>('seru24_get_messages', { p_conversation_id: conversationId, p_before_seq: null, p_limit: 100 })).map(
      m => m.client_msg_id,
    ),
  );
  return session.messages.filter(m => !m.mine).every(m => onServer.has(m.id));
};

/** Dipanggil saat online: unggah obrolan orang asing dan buang yang sudah tersimpan di server. */
export const syncStrangers = (): Promise<void> => {
  syncing ??= (async () => {
    if (!isOnline() || !account.me?.id) return;
    for (const session of await loadStrangers()) {
      if (session.unverified) continue;
      try {
        if (await syncSession(session)) await removeStranger(session.userId);
      } catch {
        // gangguan jaringan atau batas laju: dicoba lagi pada sinkron berikutnya
      }
    }
  })().finally(() => {
    syncing = null;
  });
  return syncing;
};
