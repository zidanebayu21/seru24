// Kripto end-to-end seru24, dipakai web (Nuxt) dan mobile (Expo).
// Skema (doc/database.md, bagian "Enkripsi pesan"):
//   shared  = X25519(privat_saya, publik_lawan)                          RFC 7748
//   kunci   = HKDF-SHA256(shared, salt = conversation_id, info = ...)     RFC 5869
//   isi     = AES-256-GCM, nonce acak 12 byte, AAD mengikat konteks      NIST SP 800-38D
// Backup kunci privat: scrypt(Kode Keamanan Chat) -> AES-256-GCM        RFC 7914
// OWASP ASVS V6: algoritma standar, library teraudit (@noble), CSPRNG untuk kunci dan nonce.

import { x25519 } from '@noble/curves/ed25519.js'
import { hkdf } from '@noble/hashes/hkdf.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { scryptAsync } from '@noble/hashes/scrypt.js'
import { bytesToHex, randomBytes, utf8ToBytes } from '@noble/hashes/utils.js'
import { gcm } from '@noble/ciphers/aes.js'

export const NONCE_BYTES = 12
export const KEY_BYTES = 32
export const MAX_TEXT_LENGTH = 4000

const INFO_MESSAGE = 'seru24/v1/msg'
const AAD_BACKUP = 'seru24/v1/backup'
const SCRYPT_PARAMS = { N: 2 ** 15, r: 8, p: 1 } as const

export type MessageKind = 'text' | 'image' | 'file'

export interface KeyPair {
  secretKey: Uint8Array
  publicKey: Uint8Array
}

export interface EncryptedPayload {
  ciphertext: string
  nonce: string
}

export interface MessageContext {
  conversationId: string
  senderId: string
  clientMsgId: string
  kind: MessageKind
}

export interface PartyKey {
  userId: string
  keyVersion: number
}

export interface KeyBackup {
  encrypted_keys: string
  nonce: string
  kdf: 'scrypt'
  kdf_params: { salt: string; N: number; r: number; p: number }
}

/** Kunci privat per versi, mis. { "1": <32 byte> }. */
export type SecretKeyring = Record<string, Uint8Array>

export const toBase64 = (bytes: Uint8Array): string => {
  let binary = ''
  for (const b of bytes) binary += String.fromCharCode(b)
  return btoa(binary)
}

export const fromBase64 = (value: string): Uint8Array => {
  const binary = atob(value)
  const out = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i)
  return out
}

const utf8Decode = (bytes: Uint8Array): string => new TextDecoder().decode(bytes)

export const generateKeyPair = (): KeyPair => x25519.keygen()

/**
 * Kunci simetris per percakapan. Kedua pihak mendapat kunci yang sama karena
 * `info` disusun dari pasangan (userId, keyVersion) yang diurutkan.
 */
export const deriveConversationKey = (
  mySecretKey: Uint8Array,
  peerPublicKey: Uint8Array,
  conversationId: string,
  me: PartyKey,
  peer: PartyKey,
): Uint8Array => {
  const shared = x25519.getSharedSecret(mySecretKey, peerPublicKey)
  const parties = [me, peer]
    .map((p) => `${p.userId}:${p.keyVersion}`)
    .sort((a, b) => a.localeCompare(b))
  const info = utf8ToBytes(`${INFO_MESSAGE}|${parties.join('|')}`)
  const key = hkdf(sha256, shared, utf8ToBytes(conversationId), info, KEY_BYTES)
  shared.fill(0)
  return key
}

const messageAad = (ctx: MessageContext): Uint8Array =>
  utf8ToBytes(`${ctx.conversationId}|${ctx.senderId}|${ctx.clientMsgId}|${ctx.kind}`)

const seal = (key: Uint8Array, plaintext: Uint8Array, aad: Uint8Array): EncryptedPayload => {
  const nonce = randomBytes(NONCE_BYTES)
  const ciphertext = gcm(key, nonce, aad).encrypt(plaintext)
  return { ciphertext: toBase64(ciphertext), nonce: toBase64(nonce) }
}

const open = (key: Uint8Array, payload: EncryptedPayload, aad: Uint8Array): Uint8Array =>
  gcm(key, fromBase64(payload.nonce), aad).decrypt(fromBase64(payload.ciphertext))

/** Isi pesan berupa JSON kecil, mis. { t: "halo" }. Gagal autentikasi = exception. */
export const encryptMessage = <T>(key: Uint8Array, body: T, ctx: MessageContext): EncryptedPayload =>
  seal(key, utf8ToBytes(JSON.stringify(body)), messageAad(ctx))

export const decryptMessage = <T>(key: Uint8Array, payload: EncryptedPayload, ctx: MessageContext): T =>
  JSON.parse(utf8Decode(open(key, payload, messageAad(ctx)))) as T

const deriveBackupKey = (passphrase: string, salt: Uint8Array, params: { N: number; r: number; p: number }) =>
  scryptAsync(utf8ToBytes(passphrase.normalize('NFKC')), salt, { ...params, dkLen: KEY_BYTES })

/** Bungkus semua versi kunci privat dengan Kode Keamanan Chat sebelum dikirim ke server. */
export const createKeyBackup = async (keyring: SecretKeyring, passphrase: string, userId: string): Promise<KeyBackup> => {
  const salt = randomBytes(16)
  const key = await deriveBackupKey(passphrase, salt, SCRYPT_PARAMS)
  const plain = Object.fromEntries(Object.entries(keyring).map(([v, k]) => [v, toBase64(k)]))
  const sealed = seal(key, utf8ToBytes(JSON.stringify(plain)), utf8ToBytes(`${AAD_BACKUP}|${userId}`))
  key.fill(0)
  return {
    encrypted_keys: sealed.ciphertext,
    nonce: sealed.nonce,
    kdf: 'scrypt',
    kdf_params: { salt: toBase64(salt), ...SCRYPT_PARAMS },
  }
}

/** Kode salah atau data diubah = exception. */
export const openKeyBackup = async (backup: KeyBackup, passphrase: string, userId: string): Promise<SecretKeyring> => {
  const { salt, N, r, p } = backup.kdf_params
  const key = await deriveBackupKey(passphrase, fromBase64(salt), { N, r, p })
  try {
    const plain = JSON.parse(
      utf8Decode(open(key, { ciphertext: backup.encrypted_keys, nonce: backup.nonce }, utf8ToBytes(`${AAD_BACKUP}|${userId}`))),
    ) as Record<string, string>
    return Object.fromEntries(Object.entries(plain).map(([v, k]) => [v, fromBase64(k)]))
  } finally {
    key.fill(0)
  }
}

/** Sidik jari pasangan kunci untuk dicocokkan kedua pengguna (anti penukaran kunci oleh server). */
export const safetyCode = (publicKeyA: Uint8Array, publicKeyB: Uint8Array): string => {
  const [first, second] = [publicKeyA, publicKeyB].sort((a, b) => bytesToHex(a).localeCompare(bytesToHex(b)))
  const digest = bytesToHex(sha256(new Uint8Array([...first, ...second]))).slice(0, 40)
  return digest.match(/.{1,5}/g)!.join(' ')
}

export const randomId = (): string => {
  const b = randomBytes(16)
  b[6] = (b[6] & 0x0f) | 0x40
  b[8] = (b[8] & 0x3f) | 0x80
  const h = bytesToHex(b)
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`
}
