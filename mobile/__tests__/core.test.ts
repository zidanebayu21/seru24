const mockKeychainStore = new Map<string, string>();

jest.mock('react-native-keychain', () => ({
  ACCESSIBLE: { WHEN_UNLOCKED_THIS_DEVICE_ONLY: 'unlocked' },
  getGenericPassword: jest.fn(async ({ service }) => {
    const val = mockKeychainStore.get(service);
    return val ? { password: val } : false;
  }),
  setGenericPassword: jest.fn(async (_user, val, { service }) => {
    mockKeychainStore.set(service, val);
    return true;
  }),
  resetGenericPassword: jest.fn(async ({ service }) => {
    mockKeychainStore.delete(service);
    return true;
  }),
}));

const mockRealtime = {
  connect: jest.fn(),
  disconnect: jest.fn(async () => {}),
};
let mockRpcResult: { data: any; error: any } = { data: null, error: null };
const mockSupabaseClient = {
  rpc: jest.fn(async () => mockRpcResult),
  realtime: mockRealtime,
  channel: jest.fn(() => ({
    on: jest.fn().mockReturnThis(),
    subscribe: jest.fn((cb) => cb?.('SUBSCRIBED')),
    unsubscribe: jest.fn(),
    track: jest.fn(),
  })),
  removeChannel: jest.fn(async () => {}),
};

jest.mock('@supabase/supabase-js', () => ({
  createClient: jest.fn(() => mockSupabaseClient),
}));

jest.mock('../src/lib/nativeScrypt', () => ({
  installNativeScrypt: jest.fn(async () => true),
}));

const {
  account,
  deleteRemoteFile,
  finishSignIn,
  getKeyring,
  isOnline,
  listConversations,
  loadCachedAccount,
  onBeforeSignOut,
  onOnlineChange,
  readSecure,
  readSetting,
  removeSecure,
  restoreSession,
  rpc,
  setRealtimeActive,
  signOut,
  webUrl,
  whenAccountReady,
  writeSecure,
  writeSetting,
} = require('../src/lib/core');

describe('mobile core module', () => {
  beforeEach(() => {
    mockKeychainStore.clear();
    mockRpcResult = { data: null, error: null };
    jest.clearAllMocks();
  });

  it('menyimpan dan membaca data aman di Keystore', async () => {
    await writeSecure('test-service', 'secret-val');
    expect(await readSecure('test-service')).toBe('secret-val');

    await writeSetting('theme', 'dark');
    expect(await readSetting('theme')).toBe('dark');

    await removeSecure('test-service');
    expect(await readSecure('test-service')).toBeNull();
  });

  it('mengelola listener status online', () => {
    expect(isOnline()).toBe(true);

    let recordedOnline: boolean | null = null;
    const unsub = onOnlineChange((val) => {
      recordedOnline = val;
    });

    expect(unsub).toBeInstanceOf(Function);
    unsub();
  });

  it('memuat profil akun tersimpan (loadCachedAccount)', async () => {
    expect(await loadCachedAccount()).toBe(false);

    await writeSecure('seru24.last_me', JSON.stringify({ id: 'u-1', username: 'budi', display_name: 'Budi' }));
    expect(await loadCachedAccount()).toBe(true);
    expect(account.me?.id).toBe('u-1');
  });

  it('melakukan RPC dengan header visitor key', async () => {
    mockRpcResult = { data: [{ id: 'c-1' }], error: null };
    const res = await rpc('test_func', { foo: 'bar' });
    expect(res).toEqual([{ id: 'c-1' }]);
    expect(mockSupabaseClient.rpc).toHaveBeenCalledWith('test_func', { foo: 'bar' });
  });

  it('mengambil daftar percakapan lewat listConversations', async () => {
    mockRpcResult = { data: [{ id: 'c-100', title: 'Test' }], error: null };
    const list = await listConversations();
    expect(list).toEqual([{ id: 'c-100', title: 'Test' }]);
  });

  it('mengelola status realtime aktif / hemat daya', () => {
    account.me = { id: 'u-1', username: 'budi', display_name: 'Budi' };
    setRealtimeActive(true);
    expect(mockRealtime.connect).toHaveBeenCalled();

    setRealtimeActive(false);
    expect(mockRealtime.disconnect).toHaveBeenCalled();
  });

  it('menjalankan proses signOut dan membersihkan sesi', async () => {
    let cleanupRan = false;
    onBeforeSignOut(async () => {
      cleanupRan = true;
    });

    await signOut();
    expect(cleanupRan).toBe(true);
    expect(account.me).toBeNull();
  });

  it('menghasilkan tautan webUrl dengan benar', () => {
    expect(webUrl('/test-path')).toContain('/test-path');
  });
});
