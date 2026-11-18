// Cadangan riwayat chat lokal ke satu file teks (pindah perangkat atau tambah perangkat), bersama web dan mobile.
// Isinya hanya yang sudah ada di cache lokal: daftar percakapan dan pesan yang masih terenkripsi E2EE. File
// dibungkus lagi dengan AES-256-GCM memakai kunci turunan kunci chat akun (HKDF), jadi hanya akun yang sama
// (setelah masuk dengan password) yang bisa membukanya. Pesan di dalamnya tetap terenkripsi E2EE dan baru
// terbaca setelah masuk.
// Rujukan: OWASP ASVS V6.2 (algoritma kriptografi standar), V6.4 (manajemen kunci), V8.3 (perlindungan data tersimpan).

import { hkdf } from '@noble/hashes/hkdf.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { randomBytes, utf8ToBytes } from '@noble/hashes/utils.js'
import { gcm } from '@noble/ciphers/aes.js'
import { fromBase64, toBase64, type SecretKeyring } from './crypto'
import type { Conversation } from './chat-core'
import type { ChatMessage } from './e2ee-core'

export const BACKUP_FORMAT = 'seru24-backup'
export const BACKUP_VERSION = 1
/** Batas ukuran file yang diterima saat impor (file teks, bukan lampiran). */
export const MAX_BACKUP_BYTES = 40 * 1024 * 1024

export interface BackupData {
  exportedAt: string
  conversations: Conversation[]
  messages: ChatMessage[]
}

interface BackupEnvelope {
  format: string
  version: number
  user: string
  n: string
  c: string
}

export class BackupError extends Error {}

const aad = (userId: string) => utf8ToBytes(`${BACKUP_FORMAT}:${BACKUP_VERSION}:${userId}`)

/** Kunci cadangan dari kunci chat tertua milik akun; sama di semua perangkat setelah masuk. */
const backupKey = (keyring: SecretKeyring, userId: string): Uint8Array => {
  const version = Object.keys(keyring).sort((a, b) => Number(a) - Number(b))[0]
  const secret = version === undefined ? undefined : keyring[version]
  if (!secret) throw new BackupError('Kunci chat belum siap')
  return hkdf(sha256, secret, utf8ToBytes(userId), utf8ToBytes('seru24:backup:v1'), 32)
}

export const sealBackup = (keyring: SecretKeyring, userId: string, data: BackupData): string => {
  const key = backupKey(keyring, userId)
  const nonce = randomBytes(12)
  const cipher = gcm(key, nonce, aad(userId)).encrypt(utf8ToBytes(JSON.stringify(data)))
  key.fill(0)
  const envelope: BackupEnvelope = {
    format: BACKUP_FORMAT,
    version: BACKUP_VERSION,
    user: userId,
    n: toBase64(nonce),
    c: toBase64(cipher),
  }
  return JSON.stringify(envelope)
}

const isString = (value: unknown): value is string => typeof value === 'string'

const isConversation = (value: unknown): value is Conversation => {
  const row = value as Partial<Conversation> | null
  return !!row && isString(row.id) && isString(row.peer_id) && isString(row.peer_username)
}

const isMessage = (value: unknown): value is ChatMessage => {
  const row = value as Partial<ChatMessage> | null
  return !!row && isString(row.id) && isString(row.conversation_id) && isString(row.client_msg_id)
    && typeof row.seq === 'number' && Number.isFinite(row.seq)
}

/** Buka file cadangan; gagal bila bukan file seru24, milik akun lain, rusak, atau diubah. */
export const openBackup = (keyring: SecretKeyring, userId: string, text: string): BackupData => {
  if (text.length > MAX_BACKUP_BYTES) throw new BackupError('File terlalu besar')
  let envelope: Partial<BackupEnvelope>
  try {
    envelope = JSON.parse(text) as Partial<BackupEnvelope>
  } catch {
    throw new BackupError('Bukan file cadangan seru24')
  }
  if (envelope.format !== BACKUP_FORMAT || envelope.version !== BACKUP_VERSION || !isString(envelope.n) || !isString(envelope.c)) {
    throw new BackupError('Bukan file cadangan seru24')
  }
  if (envelope.user !== userId) throw new BackupError('File cadangan ini milik akun lain')

  const key = backupKey(keyring, userId)
  let data: Partial<BackupData>
  try {
    const plain = gcm(key, fromBase64(envelope.n), aad(userId)).decrypt(fromBase64(envelope.c))
    data = JSON.parse(new TextDecoder().decode(plain)) as Partial<BackupData>
  } catch {
    throw new BackupError('File cadangan rusak atau tidak cocok dengan akun ini')
  } finally {
    key.fill(0)
  }
  if (!Array.isArray(data.conversations) || !Array.isArray(data.messages)) throw new BackupError('Isi cadangan tidak valid')
  return {
    exportedAt: isString(data.exportedAt) ? data.exportedAt : '',
    conversations: data.conversations.filter(isConversation),
    messages: data.messages.filter(isMessage),
  }
}

/** Gabungkan percakapan: yang sudah ada di perangkat ini dipertahankan (lebih baru dari server). */
export const mergeConversations = (existing: Conversation[], incoming: Conversation[]): Conversation[] => {
  const known = new Set(existing.map((conversation) => conversation.id))
  return [...existing, ...incoming.filter((conversation) => !known.has(conversation.id))]
}

export const groupMessagesByConversation = (messages: ChatMessage[]): Map<string, ChatMessage[]> => {
  const groups = new Map<string, ChatMessage[]>()
  for (const message of messages) {
    const list = groups.get(message.conversation_id)
    if (list) list.push(message)
    else groups.set(message.conversation_id, [message])
  }
  return groups
}

export const backupFileName = (now = new Date()) =>
  `seru24-cadangan-${now.toISOString().slice(0, 10)}.txt`

/** Akses ke cache chat lokal; diisi penyimpanan web (IndexedDB) atau Android (SQLite). */
export interface BackupStore {
  loadConversations: (userId: string) => Promise<Conversation[]>
  loadMessages: (userId: string, conversationId: string) => Promise<ChatMessage[]>
  saveConversations: (userId: string, list: Conversation[]) => Promise<void>
  saveMessages: (userId: string, conversationId: string, messages: ChatMessage[]) => Promise<void>
}

/** Seluruh cache lokal menjadi teks cadangan siap disimpan ke file. */
export const exportLocalBackup = async (store: BackupStore, keyring: SecretKeyring, userId: string): Promise<string> => {
  const conversations = await store.loadConversations(userId)
  const messages: ChatMessage[] = []
  for (const conversation of conversations) messages.push(...(await store.loadMessages(userId, conversation.id)))
  return sealBackup(keyring, userId, { exportedAt: new Date().toISOString(), conversations, messages })
}

/** Gabungkan isi file cadangan ke cache lokal (tidak menghapus apa pun); mengembalikan jumlah yang dibaca. */
export const importLocalBackup = async (
  store: BackupStore,
  keyring: SecretKeyring,
  userId: string,
  text: string,
): Promise<{ conversations: number; messages: number }> => {
  const data = openBackup(keyring, userId, text)
  await store.saveConversations(userId, mergeConversations(await store.loadConversations(userId), data.conversations))
  for (const [conversationId, messages] of groupMessagesByConversation(data.messages)) {
    await store.saveMessages(userId, conversationId, messages)
  }
  return { conversations: data.conversations.length, messages: data.messages.length }
}
