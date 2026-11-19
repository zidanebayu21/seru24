import { NativeModules, DeviceEventEmitter } from 'react-native';

const mockAudioNative = {
  play: jest.fn(async () => {}),
  pause: jest.fn(),
  resume: jest.fn(),
  stop: jest.fn(),
};

const mockFilesNative = {
  pickFiles: jest.fn(async () => [{ uri: 'file://a.txt', name: 'a.txt', size: 100, mime: 'text/plain' }]),
  encryptAndUpload: jest.fn(async () => ({ key: 'key1', iv: 'iv1' })),
  downloadAndSave: jest.fn(async () => 'file://downloaded/a.txt'),
  downloadToCache: jest.fn(async () => '/cache/audio.m4a'),
  openFile: jest.fn(async () => {}),
  savedFile: jest.fn(async () => '/cache/saved.txt'),
  saveTextToDownloads: jest.fn(async () => '/downloads/test.txt'),
  readTextFile: jest.fn(async () => 'hello content'),
};

Object.assign(NativeModules, {
  Seru24Audio: mockAudioNative,
  Seru24Files: mockFilesNative,
});

jest.mock('../src/lib/core', () => ({
  session: {
    getAccessToken: jest.fn(async () => 'fake-token'),
  },
  secureFetch: jest.fn(async () => ({ id: 'file-123' })),
}));

const { onVoiceState, pauseVoice, playVoice, resumeVoice, stopVoice } = require('../src/lib/audio');
const {
  downloadFile,
  downloadToCache,
  findSavedFile,
  openSavedFile,
  pickFiles,
  readTextFile,
  saveTextToDownloads,
  uploadFile,
} = require('../src/lib/files');
import type { FileMessageBody } from '../../web/shared/file-core';

describe('mobile audio & files', () => {
  const dummyFile: FileMessageBody = {
    id: 'f-1',
    name: 'voice.m4a',
    mime: 'audio/m4a',
    size: 2048,
    key: 'dummy-key',
    iv: 'dummy-iv',
  };

  it('mengendalikan pemutaran audio native', async () => {
    await playVoice(dummyFile);
    expect(mockFilesNative.downloadToCache).toHaveBeenCalled();
    expect(mockAudioNative.play).toHaveBeenCalledWith('f-1', '/cache/audio.m4a');

    pauseVoice();
    expect(mockAudioNative.pause).toHaveBeenCalled();

    resumeVoice();
    expect(mockAudioNative.resume).toHaveBeenCalled();

    stopVoice();
    expect(mockAudioNative.stop).toHaveBeenCalled();

    let receivedState: unknown = null;
    const unsub = onVoiceState((state: any) => {
      receivedState = state;
    });
    DeviceEventEmitter.emit('seru24AudioState', { id: 'f-1', state: 'playing', positionMs: 500, durationMs: 2000 });
    expect(receivedState).toEqual({ id: 'f-1', state: 'playing', positionMs: 500, durationMs: 2000 });
    unsub();
  });

  it('menjalankan modul files native (pick, read, save, download)', async () => {
    const picked = await pickFiles();
    expect(picked).toHaveLength(1);

    const saved = await saveTextToDownloads('test.txt', 'hello');
    expect(saved).toBe('/downloads/test.txt');

    const content = await readTextFile('file://a.txt', 1000);
    expect(content).toBe('hello content');

    const found = await findSavedFile('f-1');
    expect(found).toBe('/cache/saved.txt');

    await openSavedFile('file://a.txt', 'text/plain');
    expect(mockFilesNative.openFile).toHaveBeenCalledWith('file://a.txt', 'text/plain');

    const cachePath = await downloadToCache(dummyFile);
    expect(cachePath).toBe('/cache/audio.m4a');

    const downloaded = await downloadFile(dummyFile);
    expect(downloaded).toBe('file://downloaded/a.txt');

    const uploaded = await uploadFile('conv-1', { uri: 'file://a.txt', name: 'a.txt', size: 100, mime: 'text/plain' });
    expect(uploaded.id).toBe('file-123');
    expect(uploaded.key).toBe('key1');
  });
});
