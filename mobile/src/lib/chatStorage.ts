import { NativeModules } from 'react-native';
import { gcm } from '@noble/ciphers/aes.js';
import { randomBytes, utf8ToBytes } from '@noble/hashes/utils.js';
import { fromBase64, toBase64 } from '../../../web/shared/crypto';
import type { Conversation } from '../../../web/shared/chat-core';
import type { ChatMessage } from '../../../web/shared/e2ee-core';
import { readSecure, removeSecure, writeSecure } from './core';

interface NativeChatStoreModule {
  saveConversations: (userId: string, rows: Array<{ cacheKey: string; conversationId: string; sealed: string }>) => Promise<void>;
  loadConversations: (userId: string) => Promise<string[]>;
  saveMessages: (
    userId: string,
    conversationId: string,
    rows: Array<{ cacheKey: string; seq: number; sealed: string }>,
  ) => Promise<void>;
  loadConversationState: (
    userId: string,
    conversationId: string,
  ) => Promise<{ messages: string[]; deletedIds: string[]; clearedUpToSeq: number }>;
  deleteMessage: (userId: string, conversationId: string, clientMsgId: string, seq: number) => Promise<void>;
  clearConversation: (userId: string, conversationId: string, upToSeq: number) => Promise<void>;
  clearAllChats: (userId: string) => Promise<void>;
  resetDatabase: () => Promise<void>;
  getStats: (userId: string) => Promise<{ conversations: number; messages: number; sizeBytes: number }>;
}

export interface LocalChatStorageStats {
  conversations: number;
  messages: number;
  sizeBytes: number | null;
}

const native = NativeModules.Seru24ChatStore as NativeChatStoreModule | undefined;
const wrapKeyService = (userId: string) => `seru24.chat_wrap.${userId}`;
const wrapKeyCache = new Map<string, Uint8Array>();

// Fallback memori untuk lingkungan uji (Jest) atau platform tanpa modul native SQLite.
const memoryConversations = new Map<string, Map<string, { conversationId: string; sealed: string }>>();
const memoryMessages = new Map<string, Map<string, { conversationId: string; seq: number; sealed: string }>>();
const memoryDeleted = new Map<string, Set<string>>();
const memoryCleared = new Map<string, number>();

const getOrCreateWrapKey = async (userId: string): Promise<Uint8Array> => {
  const cached = wrapKeyCache.get(userId);
  if (cached) return cached;

  const stored = await readSecure(wrapKeyService(userId)).catch(() => null);
  if (stored) {
    try {
      const bytes = fromBase64(stored);
      if (bytes.length === 32) {
        wrapKeyCache.set(userId, bytes);
        return bytes;
      }
    } catch {
      // kunci rusak: buat ulang kunci baru
    }
  }

  const created = randomBytes(32);
  await writeSecure(wrapKeyService(userId), toBase64(created)).catch(() => undefined);
  wrapKeyCache.set(userId, created);
  return created;
};

const findExistingWrapKey = async (userId: string): Promise<Uint8Array | null> => {
  const cached = wrapKeyCache.get(userId);
  if (cached) return cached;

  const stored = await readSecure(wrapKeyService(userId)).catch(() => null);
  if (!stored) return null;
  try {
    const bytes = fromBase64(stored);
    if (bytes.length === 32) {
      wrapKeyCache.set(userId, bytes);
      return bytes;
    }
  } catch {
    // abaikan
  }
  return null;
};

const sealJson = (key: Uint8Array, value: unknown): string => {
  const nonce = randomBytes(12);
  const plain = utf8ToBytes(JSON.stringify(value));
  const cipher = gcm(key, nonce).encrypt(plain);
  plain.fill(0);
  return JSON.stringify({ n: toBase64(nonce), c: toBase64(cipher) });
};

const openJson = <T>(key: Uint8Array, raw: string): T | null => {
  try {
    const parsed = JSON.parse(raw) as { n?: string; c?: string };
    if (!parsed.n || !parsed.c) return null;
    const plain = gcm(key, fromBase64(parsed.n)).decrypt(fromBase64(parsed.c));
    return JSON.parse(new TextDecoder().decode(plain)) as T;
  } catch {
    return null;
  }
};

/** Simpan daftar percakapan ke penyimpanan lokal HP (terenkripsi AES-256-GCM). */
export const saveLocalConversations = async (userId: string, list: Conversation[]): Promise<void> => {
  if (!userId) return;
  const key = await getOrCreateWrapKey(userId);
  const rows = list.map(conv => ({
    cacheKey: `${userId}:${conv.id}`,
    conversationId: conv.id,
    sealed: sealJson(key, conv),
  }));

  if (native) {
    await native.saveConversations(userId, rows);
    return;
  }

  const bucket = new Map<string, { conversationId: string; sealed: string }>();
  for (const row of rows) {
    bucket.set(row.cacheKey, { conversationId: row.conversationId, sealed: row.sealed });
  }
  memoryConversations.set(userId, bucket);
};

/** Muat daftar percakapan yang tersimpan di penyimpanan lokal HP. */
export const loadLocalConversations = async (userId: string): Promise<Conversation[]> => {
  if (!userId) return [];
  const key = await findExistingWrapKey(userId);
  if (!key) return [];

  const sealedRows = native
    ? await native.loadConversations(userId).catch(() => [])
    : Array.from(memoryConversations.get(userId)?.values() ?? []).map(r => r.sealed);

  return sealedRows
    .map(raw => openJson<Conversation>(key, raw))
    .filter((c): c is Conversation => c !== null)
    .sort((a, b) => {
      if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
      return String(b.last_message_at ?? '').localeCompare(String(a.last_message_at ?? ''));
    });
};

/** Simpan atau perbarui pesan percakapan ke penyimpanan lokal HP (terenkripsi AES-256-GCM). */
export const saveLocalMessages = async (
  userId: string,
  conversationId: string,
  messages: ChatMessage[],
): Promise<void> => {
  if (!userId || !conversationId || messages.length === 0) return;
  const key = await getOrCreateWrapKey(userId);
  const rows = messages.map(msg => ({
    cacheKey: `${userId}:${conversationId}:${msg.client_msg_id}`,
    seq: msg.seq,
    sealed: sealJson(key, msg),
  }));

  if (native) {
    await native.saveMessages(userId, conversationId, rows);
    return;
  }

  let bucket = memoryMessages.get(userId);
  if (!bucket) {
    bucket = new Map();
    memoryMessages.set(userId, bucket);
  }
  for (const row of rows) {
    bucket.set(row.cacheKey, { conversationId, seq: row.seq, sealed: row.sealed });
  }
};

/** Muat pesan lokal dan penanda pesan yang sudah dihapus lokal untuk satu percakapan. */
export const loadLocalConversationState = async (
  userId: string,
  conversationId: string,
): Promise<{ messages: ChatMessage[]; deletedIds: Set<string>; clearedUpToSeq: number }> => {
  const empty = { messages: [], deletedIds: new Set<string>(), clearedUpToSeq: 0 };
  if (!userId || !conversationId) return empty;

  let sealedList: string[] = [];
  let deletedList: string[] = [];
  let clearedUpToSeq = 0;

  if (native) {
    const state = await native.loadConversationState(userId, conversationId).catch(() => null);
    if (!state) return empty;
    sealedList = state.messages;
    deletedList = state.deletedIds;
    clearedUpToSeq = state.clearedUpToSeq || 0;
  } else {
    const convKey = `${userId}:${conversationId}`;
    const bucket = memoryMessages.get(userId);
    if (bucket) {
      sealedList = Array.from(bucket.values())
        .filter(item => item.conversationId === conversationId)
        .sort((a, b) => a.seq - b.seq)
        .map(item => item.sealed);
    }
    deletedList = Array.from(memoryDeleted.get(convKey) ?? []);
    clearedUpToSeq = memoryCleared.get(convKey) ?? 0;
  }

  const deletedIds = new Set(deletedList);
  const key = await findExistingWrapKey(userId);
  if (!key) return { messages: [], deletedIds, clearedUpToSeq };

  const messages = sealedList
    .map(raw => openJson<ChatMessage>(key, raw))
    .filter((m): m is ChatMessage => m !== null && !deletedIds.has(m.client_msg_id) && m.seq > clearedUpToSeq)
    .sort((a, b) => a.seq - b.seq);

  return { messages, deletedIds, clearedUpToSeq };
};

/** Hapus satu pesan hanya di perangkat ini (tombstone mencegah muncul lagi saat sinkronisasi). */
export const deleteLocalMessage = async (
  userId: string,
  conversationId: string,
  clientMsgId: string,
  seq = 0,
): Promise<void> => {
  if (!userId || !conversationId || !clientMsgId) return;
  if (native) {
    await native.deleteMessage(userId, conversationId, clientMsgId, seq);
    return;
  }

  const cacheKey = `${userId}:${conversationId}:${clientMsgId}`;
  memoryMessages.get(userId)?.delete(cacheKey);
  const convKey = `${userId}:${conversationId}`;
  let deleted = memoryDeleted.get(convKey);
  if (!deleted) {
    deleted = new Set();
    memoryDeleted.set(convKey, deleted);
  }
  deleted.add(clientMsgId);
};

/** Hapus seluruh riwayat satu percakapan di penyimpanan lokal HP. */
export const clearLocalConversation = async (
  userId: string,
  conversationId: string,
  upToSeq = 0,
): Promise<void> => {
  if (!userId || !conversationId) return;
  if (native) {
    await native.clearConversation(userId, conversationId, upToSeq);
    return;
  }

  const bucket = memoryMessages.get(userId);
  if (bucket) {
    for (const [k, item] of bucket) {
      if (item.conversationId === conversationId) bucket.delete(k);
    }
  }
  const convKey = `${userId}:${conversationId}`;
  memoryDeleted.delete(convKey);
  memoryCleared.set(convKey, Math.max(memoryCleared.get(convKey) ?? 0, upToSeq));
};

/** Bersihkan seluruh cache chat lokal tanpa menyentuh kunci privat E2EE (keyring). */
export const clearAllLocalChats = async (userId?: string): Promise<void> => {
  if (native) {
    await native.clearAllChats(userId ?? '');
    return;
  }

  if (userId) {
    memoryConversations.delete(userId);
    memoryMessages.delete(userId);
    const prefix = `${userId}:`;
    for (const k of memoryDeleted.keys()) {
      if (k.startsWith(prefix)) memoryDeleted.delete(k);
    }
    for (const k of memoryCleared.keys()) {
      if (k.startsWith(prefix)) memoryCleared.delete(k);
    }
    return;
  }

  memoryConversations.clear();
  memoryMessages.clear();
  memoryDeleted.clear();
  memoryCleared.clear();
};

/** Hapus penuh DB cache chat lokal dan kunci pembungkus cache (tidak menghapus keyring akun). */
export const resetFullLocalStorage = async (userId?: string): Promise<void> => {
  if (userId) {
    const cached = wrapKeyCache.get(userId);
    if (cached) cached.fill(0);
    wrapKeyCache.delete(userId);
    await removeSecure(wrapKeyService(userId)).catch(() => undefined);
  } else {
    for (const key of wrapKeyCache.values()) key.fill(0);
    wrapKeyCache.clear();
  }

  if (native) {
    await native.resetDatabase();
    return;
  }

  await clearAllLocalChats();
};

/** Hitung ringkasan jumlah percakapan, pesan, dan ukuran database cache chat lokal. */
export const getLocalChatStorageStats = async (userId: string): Promise<LocalChatStorageStats> => {
  if (!userId) return { conversations: 0, messages: 0, sizeBytes: null };
  if (native) {
    try {
      const stats = await native.getStats(userId);
      return {
        conversations: stats.conversations ?? 0,
        messages: stats.messages ?? 0,
        sizeBytes: typeof stats.sizeBytes === 'number' ? stats.sizeBytes : null,
      };
    } catch {
      return { conversations: 0, messages: 0, sizeBytes: null };
    }
  }

  return {
    conversations: memoryConversations.get(userId)?.size ?? 0,
    messages: memoryMessages.get(userId)?.size ?? 0,
    sizeBytes: null,
  };
};
