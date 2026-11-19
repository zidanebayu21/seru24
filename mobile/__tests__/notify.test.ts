import { AppState, DeviceEventEmitter, NativeModules, PermissionsAndroid, Platform } from 'react-native';

const mockNotifyNative = {
  show: jest.fn(),
  setEnabled: jest.fn(),
  setPresence: jest.fn(),
  getFcmToken: jest.fn(async () => 'mock-fcm-token-123'),
};

Object.assign(NativeModules, {
  Seru24Notify: mockNotifyNative,
});

const mockSettings = new Map<string, string>();
const mockRpc = jest.fn(async () => {});
const mockSecureFetch = jest.fn(async () => {});
let inboxHandler: ((event: string, payload: any) => void) | null = null;

jest.mock('../src/lib/core', () => ({
  account: { me: { id: 'my-user-id' } },
  inbox: {
    onInbox: jest.fn((cb) => {
      inboxHandler = cb;
      return () => { inboxHandler = null; };
    }),
  },
  onBeforeSignOut: jest.fn(),
  readSetting: jest.fn(async (k: string) => mockSettings.get(k) ?? null),
  writeSetting: jest.fn(async (k: string, v: string) => { mockSettings.set(k, v); }),
  rpc: jest.fn((...args) => mockRpc(...args)),
  secureFetch: jest.fn((...args) => mockSecureFetch(...args)),
  session: {
    getAccessToken: jest.fn(async () => 'fake-access-token'),
  },
}));

const {
  disableNotifications,
  enableNotifications,
  isNotifyEnabled,
  loadNotifySetting,
  notifyMessageSent,
  notifySupported,
  startNotifications,
  stopNotifications,
  updateNotificationPresence,
} = require('../src/lib/notify');

describe('mobile notifications', () => {
  beforeEach(() => {
    mockSettings.clear();
    jest.clearAllMocks();
    AppState.currentState = 'active';
  });

  afterEach(() => {
    stopNotifications();
  });

  it('memeriksa status dukungan dan memuat setting notifikasi', async () => {
    expect(notifySupported).toBe(true);

    mockSettings.set('notifications', 'on');
    const enabled = await loadNotifySetting();
    expect(enabled).toBe(true);
    expect(isNotifyEnabled()).toBe(true);
    expect(mockNotifyNative.setEnabled).toHaveBeenCalledWith(true);
    expect(mockRpc).toHaveBeenCalledWith('seru24_register_push_token', {
      p_platform: Platform.OS,
      p_token: 'mock-fcm-token-123',
    });
  });

  it('mengaktifkan dan menonaktifkan notifikasi', async () => {
    (PermissionsAndroid as any).request = jest.fn(async () => PermissionsAndroid.RESULTS.GRANTED);
    const enabled = await enableNotifications();
    expect(enabled).toBe(true);
    expect(mockSettings.get('notifications')).toBe('on');
    expect(mockNotifyNative.setEnabled).toHaveBeenCalledWith(true);

    await disableNotifications();
    expect(isNotifyEnabled()).toBe(false);
    expect(mockSettings.get('notifications')).toBe('off');
    expect(mockNotifyNative.setEnabled).toHaveBeenCalledWith(false);
    expect(mockRpc).toHaveBeenCalledWith('seru24_unregister_push_token', {
      p_token: 'mock-fcm-token-123',
    });
  });

  it('menangani inbox pesan baru saat di luar obrolan aktif', async () => {
    await enableNotifications();
    startNotifications(() => 'conv-1');

    updateNotificationPresence('conv-1');
    expect(mockNotifyNative.setPresence).toHaveBeenCalledWith(true, 'conv-1');

    inboxHandler?.('message_new', { sender_id: 'my-user-id', conversation_id: 'conv-2' });
    expect(mockNotifyNative.show).not.toHaveBeenCalled();

    inboxHandler?.('message_new', { sender_id: 'peer-id', conversation_id: 'conv-1' });
    expect(mockNotifyNative.show).not.toHaveBeenCalled();

    inboxHandler?.('message_new', { sender_id: 'peer-id', conversation_id: 'conv-2' });
    expect(mockNotifyNative.show).toHaveBeenCalledWith('seru24', 'Pesan baru', 'conv-2');

    DeviceEventEmitter.emit('seru24:fcm_token', 'new-token-999');
  });

  it('mengirim ping push ke server saat pesan terkirim', async () => {
    notifyMessageSent('conv-1', 'msg-100');
    await new Promise((r) => setTimeout(r, 10));
    expect(mockSecureFetch).toHaveBeenCalledWith('/api/push/notify', {
      access_token: 'fake-access-token',
      conversation_id: 'conv-1',
      message_id: 'msg-100',
    });
  });
});
