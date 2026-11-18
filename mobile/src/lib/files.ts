import { DeviceEventEmitter, NativeModules } from 'react-native';
import {
  FILE_TAG_BYTES,
  MAX_FILE_BYTES,
  formatFileSize,
  safeFileName,
  type FileMessageBody,
} from '../../../web/shared/file-core';
import { API_BASE_URL } from '../env';
import { secureFetch, session } from './core';

// Dokumen chat di Android, setara web/app/utils/files.ts: enkripsi dan transfer per potongan dikerjakan
// modul native Seru24Files (Java) agar file 50 MB tidak membebani JS.

export interface PickedFile {
  uri: string;
  name: string;
  size: number;
  mime: string;
}

interface NativeFilesModule {
  pickFiles: () => Promise<PickedFile[]>;
  encryptAndUpload: (uri: string, id: string, apiBase: string, token: string) => Promise<{ key: string; iv: string }>;
  downloadAndSave: (
    id: string, apiBase: string, token: string, key: string, iv: string, name: string, mime: string, size: number,
  ) => Promise<string>;
  openFile: (uri: string, mime: string) => Promise<void>;
  savedFile: (id: string) => Promise<string | null>;
}

export type Progress = (done: number, total: number) => void;

const native = NativeModules.Seru24Files as NativeFilesModule | undefined;

const requireNative = () => {
  if (!native) throw new Error('Dokumen tidak didukung di perangkat ini');
  return native;
};

const requireToken = async () => {
  const token = await session.getAccessToken();
  if (!token) throw new Error('Sesi berakhir, silakan masuk lagi');
  return token;
};

/** Progres per lampiran dari modul native (event seru24FileProgress). */
const withProgress = async <T>(id: string, onProgress: Progress | undefined, run: () => Promise<T>): Promise<T> => {
  const subscription = DeviceEventEmitter.addListener('seru24FileProgress', (event: { id: string; done: number; total: number }) => {
    if (event.id === id) onProgress?.(event.done, event.total);
  });
  try {
    return await run();
  } finally {
    subscription.remove();
  }
};

export const pickFiles = (): Promise<PickedFile[]> => requireNative().pickFiles();

/** Enkripsi lalu unggah satu file; hasilnya isi pesan kind 'file' yang siap dienkripsi E2EE. */
export const uploadFile = async (conversationId: string, file: PickedFile, onProgress?: Progress): Promise<FileMessageBody> => {
  const files = requireNative();
  if (file.size < 0) throw new Error('Ukuran file tidak diketahui');
  if (file.size > MAX_FILE_BYTES) throw new Error(`Maksimal ${formatFileSize(MAX_FILE_BYTES)} per file`);
  const token = await requireToken();
  const start = await secureFetch<{ id: string }>('/api/files/start', {
    access_token: token,
    conversation_id: conversationId,
    size: file.size + FILE_TAG_BYTES,
  });
  const sealed = await withProgress(start.id, onProgress, () => files.encryptAndUpload(file.uri, start.id, API_BASE_URL, token));
  return {
    id: start.id,
    name: safeFileName(file.name),
    mime: file.mime || 'application/octet-stream',
    size: file.size,
    key: sealed.key,
    iv: sealed.iv,
  };
};

/** Lokasi file yang sudah pernah diunduh (masih ada di HP); null bila belum. */
export const findSavedFile = (id: string): Promise<string | null> =>
  native ? native.savedFile(id).catch(() => null) : Promise.resolve(null);

/** Buka file lokal dengan aplikasi yang sesuai (PDF, gambar, dll.). */
export const openSavedFile = (uri: string, mime: string): Promise<void> => requireNative().openFile(uri, mime);

/** Unduh, dekripsi, dan simpan ke Download/seru24, lalu buka; hasilnya lokasi file lokal. */
export const downloadFile = async (file: FileMessageBody, onProgress?: Progress): Promise<string> => {
  const files = requireNative();
  const token = await requireToken();
  const uri = await withProgress(file.id, onProgress, () =>
    files.downloadAndSave(file.id, API_BASE_URL, token, file.key, file.iv, file.name, file.mime, file.size),
  );
  await files.openFile(uri, file.mime).catch(() => undefined);
  return uri;
};
