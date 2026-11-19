const mockSecureStore = new Map<string, string>();

jest.mock('../src/lib/core', () => ({
  readSecure: jest.fn(async (service: string) => mockSecureStore.get(service) ?? null),
  writeSecure: jest.fn(async (service: string, value: string) => {
    mockSecureStore.set(service, value);
  }),
  removeSecure: jest.fn(async (service: string) => {
    mockSecureStore.delete(service);
    return true;
  }),
}));

import {
  clearAllLocalChats,
  clearLocalConversation,
  getLocalChatStorageStats,
  loadLocalConversations,
  loadLocalConversationState,
  resetFullLocalStorage,
  saveLocalConversations,
  saveLocalMessages,
} from '../src/lib/chatStorage';
import type { Conversation } from '../../web/shared/chat-core';
import type { ChatMessage } from '../../web/shared/e2ee-core';

const makeConv = (id: string, pinned = false, lastMessageAt: string | null = null): Conversation => ({
  id,
  status: 'accepted',
  requested_by: null,
  last_message_at: lastMessageAt,
  unread: 0,
  muted: false,
  archived: false,
  pinned,
  peer_id: `peer-${id}`,
  peer_username: `user_${id}`,
  peer_display_name: `User ${id}`,
  peer_blocked: false,
});

const makeMsg = (conversationId: string, clientMsgId: string, seq: number): ChatMessage => ({
  id: `msg-${seq}`,
  conversation_id: conversationId,
  sender_id: 'u1',
  seq,
  client_msg_id: clientMsgId,
  kind: 'text',
  ciphertext: `cipher-${seq}`,
  nonce: 'AAAAAAAAAAAAAAAA',
  sender_key_version: 1,
  recipient_key_version: 1,
  reply_to: null,
  created_at: `2026-11-18T00:00:0${seq}Z`,
  edited_at: null,
  deleted_at: null,
  expires_at: null,
});

describe('mobile chatStorage', () => {
  beforeEach(async () => {
    mockSecureStore.clear();
    await resetFullLocalStorage('u1');
  });

  it('menyimpan dan memuat daftar percakapan secara terenkripsi di Keystore wrap key', async () => {
    const c1 = makeConv('c1', false, '2026-11-18T01:00:00Z');
    const c2 = makeConv('c2', true, '2026-11-17T01:00:00Z');
    await saveLocalConversations('u1', [c1, c2]);

    const loaded = await loadLocalConversations('u1');
    expect(loaded.map(c => c.id)).toEqual(['c2', 'c1']);
    expect(mockSecureStore.has('seru24.chat_wrap.u1')).toBe(true);
  });

  it('menyimpan pesan dan membersihkan 1 percakapan sampai seq tertentu', async () => {
    const m1 = makeMsg('conv1', 'cm1', 1);
    const m2 = makeMsg('conv1', 'cm2', 2);
    const m3 = makeMsg('conv1', 'cm3', 3);
    await saveLocalMessages('u1', 'conv1', [m3, m1, m2]);

    let state = await loadLocalConversationState('u1', 'conv1');
    expect(state.messages.map(m => m.seq)).toEqual([1, 2, 3]);
    expect(state.deletedIds.size).toBe(0);

    await clearLocalConversation('u1', 'conv1', 3);
    state = await loadLocalConversationState('u1', 'conv1');
    expect(state.messages).toEqual([]);
    expect(state.clearedUpToSeq).toBe(3);

    await saveLocalMessages('u1', 'conv1', [m3, makeMsg('conv1', 'cm4', 4)]);
    state = await loadLocalConversationState('u1', 'conv1');
    expect(state.messages.map(m => m.seq)).toEqual([4]);
  });

  it('membersihkan seluruh chat lokal dan mereset database penuh tanpa menghapus keyring lain', async () => {
    mockSecureStore.set('seru24.keyring.u1', 'keep-me');
    await saveLocalConversations('u1', [makeConv('c1')]);
    await saveLocalMessages('u1', 'c1', [makeMsg('c1', 'cm1', 1)]);

    let stats = await getLocalChatStorageStats('u1');
    expect(stats.conversations).toBe(1);
    expect(stats.messages).toBe(1);

    await clearAllLocalChats('u1');
    stats = await getLocalChatStorageStats('u1');
    expect(stats.conversations).toBe(0);
    expect(stats.messages).toBe(0);

    await saveLocalConversations('u1', [makeConv('c2')]);
    await resetFullLocalStorage('u1');
    expect(await loadLocalConversations('u1')).toEqual([]);
    expect(mockSecureStore.has('seru24.chat_wrap.u1')).toBe(false);
    expect(mockSecureStore.get('seru24.keyring.u1')).toBe('keep-me');
  });

  it('menggunakan modul native SQLite bila NativeModules.Seru24ChatStore terpasang', async () => {
    const { NativeModules } = require('react-native');
    const mockNative = {
      saveConversations: jest.fn(async () => {}),
      loadConversations: jest.fn(async () => ['{"n":"AA==","c":"BB=="}']),
      saveMessages: jest.fn(async () => {}),
      loadConversationState: jest.fn(async () => ({ messages: [], deletedIds: [], clearedUpToSeq: 0 })),
      clearConversation: jest.fn(async () => {}),
      clearAllChats: jest.fn(async () => {}),
      resetDatabase: jest.fn(async () => {}),
      getStats: jest.fn(async () => ({ conversations: 5, messages: 10, sizeBytes: 2048 })),
    };
    Object.assign(NativeModules, { Seru24ChatStore: mockNative });

    jest.isolateModules(async () => {
      const storage = require('../src/lib/chatStorage');
      await storage.saveLocalConversations('u1', [makeConv('c1')]);
      expect(mockNative.saveConversations).toHaveBeenCalled();

      await storage.loadLocalConversations('u1');
      expect(mockNative.loadConversations).toHaveBeenCalled();

      await storage.saveLocalMessages('u1', 'c1', [makeMsg('c1', 'm1', 1)]);
      expect(mockNative.saveMessages).toHaveBeenCalled();

      await storage.loadLocalConversationState('u1', 'c1');
      expect(mockNative.loadConversationState).toHaveBeenCalled();

      await storage.clearLocalConversation('u1', 'c1', 1);
      expect(mockNative.clearConversation).toHaveBeenCalled();

      await storage.clearAllLocalChats('u1');
      expect(mockNative.clearAllChats).toHaveBeenCalled();

      await storage.resetFullLocalStorage('u1');
      expect(mockNative.resetDatabase).toHaveBeenCalled();

      const stats = await storage.getLocalChatStorageStats('u1');
      expect(stats.conversations).toBe(5);
      expect(stats.sizeBytes).toBe(2048);
    });

    delete (NativeModules as any).Seru24ChatStore;
  });
});
