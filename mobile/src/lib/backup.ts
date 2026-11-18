import {
  MAX_BACKUP_BYTES,
  backupFileName,
  exportLocalBackup,
  importLocalBackup,
  type BackupStore,
} from '../../../web/shared/backup-core';
import {
  loadLocalConversationState,
  loadLocalConversations,
  saveLocalConversations,
  saveLocalMessages,
} from './chatStorage';
import { getKeyring } from './core';
import { pickFiles, readTextFile, saveTextToDownloads } from './files';

// Cadangan riwayat chat lokal ke file teks (format dan enkripsi di web/shared/backup-core.ts).

const store: BackupStore = {
  loadConversations: loadLocalConversations,
  loadMessages: async (userId, conversationId) => (await loadLocalConversationState(userId, conversationId)).messages,
  saveConversations: saveLocalConversations,
  saveMessages: saveLocalMessages,
};

const requireKeyring = () => {
  const keyring = getKeyring();
  if (!keyring) throw new Error('Kunci chat belum siap');
  return keyring;
};

/** Simpan seluruh cache chat ke Download/seru24; hasilnya nama file. */
export const exportBackupFile = async (userId: string): Promise<string> =>
  saveTextToDownloads(backupFileName(), await exportLocalBackup(store, requireKeyring(), userId));

/** Pilih file cadangan lalu gabungkan ke cache lokal; null bila pemilihan dibatalkan. */
export const importBackupFile = async (userId: string) => {
  const [file] = await pickFiles();
  if (!file) return null;
  const text = await readTextFile(file.uri, MAX_BACKUP_BYTES);
  return importLocalBackup(store, requireKeyring(), userId, text);
};
