const mockSettings = new Map<string, string>();
let mockOnline = true;
const mockRpc = jest.fn();
const mockList = jest.fn();
const mockEncrypt = jest.fn();
const mockCheck = jest.fn(async (): Promise<string> => 'match');

jest.mock('../src/lib/core', () => ({
  account: { me: { id: 'me-1' } },
  readSetting: jest.fn(async (k: string) => mockSettings.get(k) ?? null),
  writeSetting: jest.fn(async (k: string, v: string) => { mockSettings.set(k, v); }),
  isOnline: () => mockOnline,
  rpc: (...args: unknown[]) => mockRpc(...args),
  listConversations: () => mockList(),
  e2ee: {
    encryptText: (...args: unknown[]) => mockEncrypt(...args),
    checkClaimedKey: (...args: unknown[]) => mockCheck(...(args as [])),
  },
}));
jest.mock('../src/lib/notify', () => ({ notifyMessageSent: jest.fn() }));

const { addStrangerMessage, loadStrangers, markStrangerAcked, syncStrangers, upsertStranger } = require('../src/lib/strangers');

const identity = { userId: 'u-2', username: 'budi_1', keyVersion: 1, publicKey: 'pk' };
const message = (id: string, mine: boolean) => ({ id, mine, text: `teks ${id}`, createdAt: '2026-11-19T10:00:00Z', acked: false, synced: false });

/** rpc palsu: nama fungsi -> hasil. */
const serverReplies = (replies: Record<string, unknown>) =>
  mockRpc.mockImplementation(async (name: string) => {
    if (!(name in replies)) throw new Error(`rpc tak terduga: ${name}`);
    return replies[name];
  });

describe('strangers store', () => {
  beforeEach(() => {
    mockSettings.clear();
    mockOnline = true;
    jest.clearAllMocks();
    mockCheck.mockResolvedValue('match');
    mockEncrypt.mockImplementation(async (_c: string, _u: string, _t: string, _r: boolean, extra: { clientMsgId: string }) => ({
      p_conversation_id: 'conv-9', p_client_msg_id: extra.clientMsgId, p_kind: 'text', p_ciphertext: 'c', p_nonce: 'n',
      p_sender_key_version: 1, p_recipient_key_version: 1,
    }));
  });

  it('menyimpan sesi dan pesan tanpa duplikat, serta menandai ack', async () => {
    await upsertStranger(identity);
    await addStrangerMessage('u-2', message('a', true));
    await addStrangerMessage('u-2', message('a', true));
    await markStrangerAcked('a');
    const [session] = await loadStrangers();
    expect(session.messages).toHaveLength(1);
    expect(session.messages[0].acked).toBe(true);
  });

  it('mengunggah pesan milik kita dengan id percakapan asli dan client_msg_id yang sama, lalu membuang sesi', async () => {
    await upsertStranger(identity);
    await addStrangerMessage('u-2', message('a', true));
    serverReplies({
      seru24_search_user: [{ id: 'u-2', username: 'budi_1' }],
      seru24_start_direct_chat: { ok: true, conversation_id: 'conv-9' },
      seru24_send_message: { ok: true, id: 'srv-1' },
      seru24_get_messages: [],
    });
    await syncStrangers();
    expect(mockEncrypt).toHaveBeenCalledWith('conv-9', 'u-2', 'teks a', true, { clientMsgId: 'a' });
    expect(mockRpc).toHaveBeenCalledWith('seru24_send_message', expect.objectContaining({ p_client_msg_id: 'a', p_conversation_id: 'conv-9' }));
    expect(await loadStrangers()).toEqual([]);
  });

  it('sesi dipertahankan selama pesan lawan bicara belum ada di server', async () => {
    await upsertStranger(identity);
    await addStrangerMessage('u-2', message('a', true));
    await addStrangerMessage('u-2', message('b', false));
    serverReplies({
      seru24_search_user: [{ id: 'u-2' }],
      seru24_start_direct_chat: { ok: true, conversation_id: 'conv-9' },
      seru24_send_message: { ok: true, id: 'srv-1' },
      seru24_get_messages: [],
    });
    await syncStrangers();
    const [session] = await loadStrangers();
    expect(session.messages.find((m: { id: string }) => m.id === 'a').synced).toBe(true);
    expect(session.messages).toHaveLength(2);
  });

  it('sesi yang hanya menerima tidak membuat permintaan chat baru', async () => {
    await upsertStranger(identity);
    await addStrangerMessage('u-2', message('b', false));
    mockList.mockResolvedValue([]);
    serverReplies({ seru24_search_user: [{ id: 'u-2' }] });
    await syncStrangers();
    expect(mockRpc).not.toHaveBeenCalledWith('seru24_start_direct_chat', expect.anything());
    expect(await loadStrangers()).toHaveLength(1);
  });

  it('username yang tidak cocok dengan id ditandai tidak terverifikasi dan tidak diunggah', async () => {
    await upsertStranger(identity);
    await addStrangerMessage('u-2', message('a', true));
    serverReplies({ seru24_search_user: [{ id: 'u-lain' }] });
    await syncStrangers();
    expect(mockRpc).not.toHaveBeenCalledWith('seru24_send_message', expect.anything());
    expect((await loadStrangers())[0].unverified).toBe(true);
  });

  it('kunci yang berbeda dari server memberi peringatan', async () => {
    mockCheck.mockResolvedValue('mismatch');
    await upsertStranger(identity);
    await addStrangerMessage('u-2', message('a', true));
    serverReplies({
      seru24_search_user: [{ id: 'u-2' }],
      seru24_start_direct_chat: { ok: true, conversation_id: 'conv-9' },
      seru24_send_message: { ok: false, code: 'rate_limited' },
    });
    await syncStrangers();
    expect((await loadStrangers())[0].keyWarning).toBe(true);
  });

  it('tidak berbuat apa-apa saat offline', async () => {
    mockOnline = false;
    await upsertStranger(identity);
    await syncStrangers();
    expect(mockRpc).not.toHaveBeenCalled();
  });
});
