import { NativeModules } from 'react-native';

const mockScryptNative = {
  derive: jest.fn(async () =>
    '/bq+HJ00cgB4VucZDQHp/nxq18vII3gw53N2Y0s3MWIurzDZLiKjiG/xCSedmDDaxyevuUqD7m2DYMvfoswGQA==',
  ),
};

const mockUpdateNative = {
  canInstall: jest.fn(async () => true),
  openInstallSettings: jest.fn(async () => {}),
  downloadAndInstall: jest.fn(async () => {}),
  cleanupUpdates: jest.fn(async () => {}),
};

Object.assign(NativeModules, {
  Seru24Scrypt: mockScryptNative,
  Seru24Update: mockUpdateNative,
});

const mockKeyring = { '1': new Uint8Array(32) };
jest.mock('../src/lib/core', () => ({
  getKeyring: jest.fn(() => mockKeyring),
}));

jest.mock('../src/lib/files', () => ({
  saveTextToDownloads: jest.fn(async (name: string) => `/downloads/${name}`),
  pickFiles: jest.fn(async () => [{ uri: 'file://backup.txt', name: 'backup.txt' }]),
  readTextFile: jest.fn(async () => 'dummy-encrypted-backup-text'),
}));

jest.mock('../src/lib/chatStorage', () => ({
  loadLocalConversations: jest.fn(async () => []),
  loadLocalConversationState: jest.fn(async () => ({ messages: [] })),
  saveLocalConversations: jest.fn(async () => {}),
  saveLocalMessages: jest.fn(async () => {}),
}));

jest.mock('../../web/shared/backup-core', () => ({
  MAX_BACKUP_BYTES: 10000,
  backupFileName: jest.fn(() => 'backup-test.txt'),
  exportLocalBackup: jest.fn(async () => 'export-content'),
  importLocalBackup: jest.fn(async () => ({ conversations: 1, messages: 5 })),
}));

const { exportBackupFile, importBackupFile } = require('../src/lib/backup');
const { installNativeScrypt } = require('../src/lib/nativeScrypt');
const { checkForUpdate, installUpdate } = require('../src/lib/update');

describe('mobile backup, scrypt & update', () => {
  it('ekspor dan impor backup file', async () => {
    const exported = await exportBackupFile('user-1');
    expect(exported).toBe('/downloads/backup-test.txt');

    const imported = await importBackupFile('user-1');
    expect(imported).toEqual({ conversations: 1, messages: 5 });
  });

  it('menginstal native scrypt bila lolos vektor uji RFC 7914', async () => {
    const installed = await installNativeScrypt();
    expect(installed).toBe(true);
    expect(mockScryptNative.derive).toHaveBeenCalled();
  });

  it('memeriksa dan menginstal update APK', async () => {
    global.fetch = jest.fn(async () => ({
      ok: true,
      json: async () => ({
        latest: {
          versionCode: 999999,
          versionName: '1.2.0',
          url: 'https://drive.google.com/file/d/abcdefghij123456/view',
          downloadUrl: 'https://drive.usercontent.google.com/download?id=abcdefghij123456&export=download&confirm=t',
          sha256: 'a'.repeat(64),
        },
      }),
    })) as any;

    const release = await checkForUpdate();
    expect(release).toBeTruthy();
    expect(release?.versionCode).toBe(999999);

    const result = await installUpdate(release!);
    expect(result).toBe('started');
    expect(mockUpdateNative.downloadAndInstall).toHaveBeenCalledWith(release!.downloadUrl, release!.sha256);
  });
});
