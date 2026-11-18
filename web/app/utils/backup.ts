import {
  MAX_BACKUP_BYTES,
  backupFileName,
  exportLocalBackup,
  importLocalBackup,
  type BackupStore,
} from '#shared/backup-core'

// Cadangan riwayat chat lokal ke file teks (format dan enkripsi di shared/backup-core.ts).

const store: BackupStore = {
  loadConversations: loadLocalConversations,
  loadMessages: async (userId, conversationId) => (await loadLocalConversationState(userId, conversationId)).messages,
  saveConversations: saveLocalConversations,
  saveMessages: saveLocalMessages,
}

const requireKeyring = () => {
  const keyring = getKeyring()
  if (!keyring) throw new Error('Kunci chat belum siap')
  return keyring
}

/** Unduh seluruh cache chat browser ini sebagai satu file .txt. */
export const downloadLocalBackup = async (userId: string): Promise<void> => {
  const text = await exportLocalBackup(store, requireKeyring(), userId)
  const url = URL.createObjectURL(new Blob([text], { type: 'text/plain' }))
  const link = document.createElement('a')
  link.href = url
  link.download = backupFileName()
  link.click()
  URL.revokeObjectURL(url)
}

/** Gabungkan file cadangan yang dipilih ke cache chat browser ini. */
export const importLocalBackupFile = async (userId: string, file: File) => {
  if (file.size > MAX_BACKUP_BYTES) throw new Error('File terlalu besar')
  return importLocalBackup(store, requireKeyring(), userId, await file.text())
}
