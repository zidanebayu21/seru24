const mockSettings = new Map<string, string>();

jest.mock('../src/lib/core', () => ({
  account: { me: { id: 'user-1' } },
  readSetting: jest.fn(async (k: string) => mockSettings.get(k) ?? null),
  writeSetting: jest.fn(async (k: string, v: string) => { mockSettings.set(k, v); }),
}));

const { dropNearbyReceived, nearbyReceivedFor, nearbySupported, saveNearbyReceived } = require('../src/lib/nearby');
import type { ChatMessage } from '../../web/shared/e2ee-core';

const message = (id: string, conversationId = 'conv-1'): ChatMessage => ({
  id,
  conversation_id: conversationId,
  sender_id: 'peer-1',
  seq: 0,
  client_msg_id: id,
  kind: 'text',
  ciphertext: 'c',
  nonce: 'n',
  sender_key_version: 1,
  recipient_key_version: 1,
  reply_to: null,
  created_at: '2026-11-19T10:00:00.000Z',
  edited_at: null,
  deleted_at: null,
  expires_at: null,
});

describe('mobile nearby inbox', () => {
  beforeEach(() => mockSettings.clear());

  it('tidak didukung tanpa modul native (Jest)', () => {
    expect(nearbySupported).toBe(false);
  });

  it('menyimpan tanpa duplikat dan memisahkan per percakapan', async () => {
    await saveNearbyReceived(message('a'));
    await saveNearbyReceived(message('a'));
    await saveNearbyReceived(message('b', 'conv-2'));
    expect(await nearbyReceivedFor('conv-1')).toHaveLength(1);
    expect(await nearbyReceivedFor('conv-2')).toHaveLength(1);
  });

  it('membuang pesan yang sudah ada di server', async () => {
    await saveNearbyReceived(message('a'));
    await saveNearbyReceived(message('c'));
    await dropNearbyReceived(['a']);
    expect((await nearbyReceivedFor('conv-1')).map(m => m.client_msg_id)).toEqual(['c']);
  });

  it('data penyimpanan rusak dianggap kosong', async () => {
    mockSettings.set('nearbyInbox.user-1', '{oops');
    expect(await nearbyReceivedFor('conv-1')).toEqual([]);
  });
});
