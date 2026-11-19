const mockSettings = new Map<string, string>();
let mockHandler: (event: { type: string; id: string; value: string }) => void = () => undefined;
const mockClaimCheck = jest.fn(async (): Promise<string> => 'unknown');
const mockDecrypt = jest.fn(async (): Promise<string | null> => 'halo');

jest.mock('../src/lib/core', () => ({
  account: { me: { id: 'me-1', username: 'saya' } },
  readSetting: jest.fn(async (k: string) => mockSettings.get(k) ?? null),
  writeSetting: jest.fn(async (k: string, v: string) => { mockSettings.set(k, v); }),
  isOnline: () => false,
  whenAccountReady: async () => 'ready',
  rpc: jest.fn(),
  listConversations: jest.fn(),
  e2ee: {
    myPublicKey: () => ({ user_id: 'me-1', key_version: 1, public_key: `${'A'.repeat(43)}=` }),
    checkClaimedKey: (...args: unknown[]) => mockClaimCheck(...(args as [])),
    claimedSafetyCode: () => '11111 22222',
    decryptText: (...args: unknown[]) => mockDecrypt(...(args as [])),
    encryptText: jest.fn(),
  },
}));
jest.mock('../src/lib/notify', () => ({ notifyMessageSent: jest.fn() }));
jest.mock('../src/lib/chatStorage', () => ({
  loadLocalConversations: jest.fn(async () => [{ id: 'conv-1', peer_id: 'peer-contact', peer_blocked: false }]),
}));
jest.mock('../src/lib/nearby', () => ({
  nearbySupported: true,
  onNearbyEvent: (listener: typeof mockHandler) => {
    mockHandler = listener;
    return () => undefined;
  },
  startNearby: jest.fn(async () => undefined),
  stopNearby: jest.fn(async () => undefined),
  requestNearby: jest.fn(async () => undefined),
  acceptNearby: jest.fn(),
  rejectNearby: jest.fn(),
  disconnectNearby: jest.fn(),
  sendNearby: jest.fn(async () => undefined),
  saveNearbyReceived: jest.fn(async () => undefined),
}));

const nearby = require('../src/lib/nearby');
const radar = require('../src/lib/radar');
const { contactTag } = require('../../web/shared/nearby-core');
const { loadStrangers } = require('../src/lib/strangers');

const flush = async () => {
  for (let i = 0; i < 5; i++) await new Promise(resolve => setImmediate(resolve));
};
const emit = async (type: string, id: string, value = '') => {
  mockHandler({ type, id, value });
  await flush();
};
const nameOf = (id: string, tags: string[] = []) => `s1|Anonim-4F2A|${id}|${tags.join(',')}`;
const hello = (userId: string, username = 'budi_1') =>
  JSON.stringify({ t: 'hello', h: { u: userId, n: username, k: 1, pk: `${'B'.repeat(43)}=` } });
const peerOf = (id: string) => radar.getRadarPeers().find((p: { endpointId: string }) => p.endpointId === id);

describe('radar', () => {
  afterAll(async () => {
    await radar.stopRadar();
  });

  beforeEach(async () => {
    await radar.stopRadar();
    mockSettings.clear();
    jest.clearAllMocks();
    mockClaimCheck.mockResolvedValue('unknown');
    mockDecrypt.mockResolvedValue('halo');
    expect(await radar.startRadar()).toBe(true);
  });

  it('mengumumkan alias acak dan tag kontak, bukan username', () => {
    const name: string = nearby.startNearby.mock.calls[0][0];
    expect(name).toMatch(/^s1\|Anonim-[0-9A-F]{4}\|[0-9a-f]{8}\|/);
    expect(name).toContain(contactTag('conv-1', 'me-1'));
    expect(name).not.toContain('saya');
  });

  it('orang asing hanya muncul di daftar dan baru diminta saat dihubungi', async () => {
    await emit('found', 'e1', nameOf('aaaaaaaa'));
    expect(peerOf('e1').phase).toBe('found');
    expect(nearby.requestNearby).not.toHaveBeenCalled();
    await radar.connectTo('e1');
    expect(nearby.requestNearby).toHaveBeenCalledWith('e1');
    expect(peerOf('e1').phase).toBe('requesting');
  });

  it('kontak tersambung otomatis hanya dari satu sisi', async () => {
    const tag = contactTag('conv-1', 'peer-contact');
    await emit('found', 'hi', nameOf('ffffffff', [tag]));
    await emit('found', 'lo', nameOf('00000000', [tag]));
    expect(nearby.requestNearby).toHaveBeenCalledWith('hi');
    expect(nearby.requestNearby).not.toHaveBeenCalledWith('lo');
  });

  it('nama siaran tidak sah diabaikan', async () => {
    await emit('found', 'x', 'budi');
    expect(peerOf('x')).toBeUndefined();
  });

  it('permintaan orang asing menunggu persetujuan dan identitas kita baru dikirim setelah diterima', async () => {
    await emit('incoming', 'e2', `${nameOf('bbbbbbbb')}\n1234`);
    expect(nearby.acceptNearby).toHaveBeenCalledWith('e2');
    await emit('payload', 'e2', hello('stranger-1'));
    expect(peerOf('e2').phase).toBe('incoming');
    expect(peerOf('e2').identity.username).toBe('budi_1');
    expect(nearby.sendNearby).not.toHaveBeenCalled();

    await radar.acceptIncoming('e2');
    await flush();
    expect(nearby.sendNearby.mock.calls[0][1]).toContain('"t":"hello"');
    expect(peerOf('e2').phase).toBe('ready');
    expect((await loadStrangers())[0]).toMatchObject({ userId: 'stranger-1', username: 'budi_1' });
  });

  it('menolak permintaan memutus sambungan', async () => {
    await emit('incoming', 'e3', `${nameOf('cccccccc')}\n1234`);
    await emit('payload', 'e3', hello('stranger-2'));
    radar.rejectIncoming('e3');
    expect(nearby.disconnectNearby).toHaveBeenCalledWith('e3');
    expect(peerOf('e3')).toBeUndefined();
  });

  it('kontak dengan kunci cocok langsung dipercaya tanpa persetujuan', async () => {
    mockClaimCheck.mockResolvedValue('match');
    await emit('incoming', 'e4', `${nameOf('dddddddd', [contactTag('conv-1', 'peer-contact')])}\n1234`);
    await emit('payload', 'e4', hello('peer-contact', 'teman'));
    expect(peerOf('e4')).toMatchObject({ phase: 'ready', trusted: true });
    expect(radar.readyPeerFor('peer-contact')).toBeDefined();
  });

  it('kunci kontak yang berbeda ditolak dan diberi peringatan', async () => {
    mockClaimCheck.mockResolvedValue('mismatch');
    await emit('incoming', 'e5', `${nameOf('eeeeeeee', [contactTag('conv-1', 'peer-contact')])}\n1234`);
    await emit('payload', 'e5', hello('peer-contact', 'teman'));
    expect(nearby.disconnectNearby).toHaveBeenCalledWith('e5');
    expect(radar.getRadarWarning()).toContain('berbeda');
  });

  it('tag kontak yang dipakai orang lain ditolak', async () => {
    await emit('incoming', 'e6', `${nameOf('12121212', [contactTag('conv-1', 'peer-contact')])}\n1234`);
    await emit('payload', 'e6', hello('orang-lain'));
    expect(nearby.disconnectNearby).toHaveBeenCalledWith('e6');
  });

  it('payload rusak berulang memutus sambungan', async () => {
    await emit('incoming', 'e7', `${nameOf('34343434')}\n1234`);
    for (let i = 0; i < 3; i++) await emit('payload', 'e7', '{oops');
    expect(nearby.disconnectNearby).toHaveBeenCalledWith('e7');
  });

  it('pesan orang asing yang diterima dibuka, disimpan, dan dibalas ack', async () => {
    await emit('incoming', 'e8', `${nameOf('56565656')}\n1234`);
    await emit('payload', 'e8', hello('stranger-3'));
    await radar.acceptIncoming('e8');
    await flush();
    nearby.sendNearby.mockClear();
    const events: unknown[] = [];
    radar.onRadarMessage((event: unknown) => events.push(event));
    const msg = JSON.stringify({
      t: 'msg',
      m: { client_msg_id: 'm-1', ciphertext: 'c', nonce: 'n', sender_key_version: 1, recipient_key_version: 1, created_at: new Date().toISOString() },
    });
    await emit('payload', 'e8', msg);
    expect(nearby.sendNearby.mock.calls[0][1]).toBe('{"t":"ack","id":"m-1"}');
    expect((await loadStrangers())[0].messages[0]).toMatchObject({ id: 'm-1', mine: false, text: 'halo' });
    expect(events).toEqual([{ kind: 'stranger', userId: 'stranger-3' }]);
  });

  it('pesan yang tidak bisa dibuka dibuang tanpa ack', async () => {
    await emit('incoming', 'e9', `${nameOf('78787878')}\n1234`);
    await emit('payload', 'e9', hello('stranger-4'));
    await radar.acceptIncoming('e9');
    await flush();
    nearby.sendNearby.mockClear();
    mockDecrypt.mockResolvedValue(null);
    await emit('payload', 'e9', JSON.stringify({
      t: 'msg',
      m: { client_msg_id: 'm-2', ciphertext: 'c', nonce: 'n', sender_key_version: 1, recipient_key_version: 1, created_at: new Date().toISOString() },
    }));
    expect(nearby.sendNearby).not.toHaveBeenCalled();
    expect((await loadStrangers())[0].messages).toHaveLength(0);
  });

  it('pesan sebelum handshake selesai diabaikan', async () => {
    await emit('incoming', 'e10', `${nameOf('90909090')}\n1234`);
    await emit('payload', 'e10', JSON.stringify({
      t: 'msg',
      m: { client_msg_id: 'm-3', ciphertext: 'c', nonce: 'n', sender_key_version: 1, recipient_key_version: 1, created_at: new Date().toISOString() },
    }));
    expect(nearby.sendNearby).not.toHaveBeenCalled();
  });
});
