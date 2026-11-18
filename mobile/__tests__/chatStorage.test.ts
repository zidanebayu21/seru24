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
  deleteLocalMessage,
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

  it('menyimpan pesan, menghapus 1 pesan lokal (tombstone), dan membersihkan 1 percakapan', async () => {
    const m1 = makeMsg('conv1', 'cm1', 1);
    const m2 = makeMsg('conv1', 'cm2', 2);
    const m3 = makeMsg('conv1', 'cm3', 3);
    await saveLocalMessages('u1', 'conv1', [m3, m1, m2]);

    let state = await loadLocalConversationState('u1', 'conv1');
    expect(state.messages.map(m => m.seq)).toEqual([1, 2, 3]);
    expect(state.deletedIds.size).toBe(0);

    await deleteLocalMessage('u1', 'conv1', 'cm2', 2);
    state = await loadLocalConversationState('u1', 'conv1');
    expect(state.messages.map(m => m.seq)).toEqual([1, 3]);
    expect(state.deletedIds.has('cm2')).toBe(true);

    await clearLocalConversation('u1', 'conv1', 3);
    state = await loadLocalConversationState('u1', 'conv1');
    expect(state.messages).toEqual([]);
    expect(state.clearedUpToSeq).toBe(3);
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
});
