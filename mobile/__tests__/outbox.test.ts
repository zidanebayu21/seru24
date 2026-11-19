const mockSettings = new Map<string, string>();
let mockRpc = jest.fn();

jest.mock('../src/lib/core', () => ({
  account: { me: { id: 'user-1' } },
  readSetting: jest.fn(async (k: string) => mockSettings.get(k) ?? null),
  writeSetting: jest.fn(async (k: string, v: string) => { mockSettings.set(k, v); }),
  rpc: jest.fn((...args) => mockRpc(...args)),
}));

const { flushOutbox, onQueuedSent, queueMessage, queuedFor } = require('../src/lib/outbox');
import type { QueuedMessage } from '../src/lib/outbox';

describe('mobile outbox', () => {
  const dummyItem: QueuedMessage = {
    conversationId: 'conv-1',
    params: {
      p_conversation_id: 'conv-1',
      p_client_msg_id: 'msg-1',
      p_kind: 'text',
      p_ciphertext: 'c-1',
      p_nonce: 'n-1',
      p_sender_key_version: 1,
      p_recipient_key_version: 1,
    },
    queuedAt: new Date().toISOString(),
  };

  beforeEach(() => {
    mockSettings.clear();
    mockRpc = jest.fn();
    jest.clearAllMocks();
  });

  it('mengantrekan pesan dan mengambil antrean per percakapan', async () => {
    await queueMessage(dummyItem);
    await queueMessage(dummyItem);

    const forConv1 = await queuedFor('conv-1');
    expect(forConv1).toHaveLength(1);
    expect(forConv1[0]?.params.p_client_msg_id).toBe('msg-1');

    const forConv2 = await queuedFor('conv-2');
    expect(forConv2).toHaveLength(0);
  });

  it('mengirim antrean pesan lewat rpc dan memicu listener', async () => {
    await queueMessage(dummyItem);
    mockRpc.mockResolvedValueOnce({ ok: true, id: 'server-msg-1' });

    let sentResult: any = null;
    const unsub = onQueuedSent((item, res) => {
      sentResult = { item, res };
    });

    await flushOutbox();

    expect(mockRpc).toHaveBeenCalledWith('seru24_send_message', dummyItem.params);
    expect(sentResult).toBeTruthy();
    expect(sentResult.res.ok).toBe(true);

    const remaining = await queuedFor('conv-1');
    expect(remaining).toHaveLength(0);

    unsub();
  });

  it('menahan pesan di antrean bila jaringan gagal (rpc error)', async () => {
    await queueMessage(dummyItem);
    mockRpc.mockRejectedValueOnce(new Error('Network disconnected'));

    await flushOutbox();

    const remaining = await queuedFor('conv-1');
    expect(remaining).toHaveLength(1);
  });
});
