// Kripto end-to-end seru24, dipakai web (Nuxt) dan mobile (Expo).
// Skema (doc/database.md, bagian "Enkripsi pesan"):
//   shared  = X25519(privat_saya, publik_lawan)                          RFC 7748
//   kunci   = HKDF-SHA256(shared, salt = conversation_id, info = ...)     RFC 5869
//   isi     = AES-256-GCM, nonce acak 12 byte, AAD mengikat konteks      NIST SP 800-38D
// Password: scrypt(password, salt per akun) -> HKDF -> dua kunci terpisah  RFC 7914, RFC 5869
//   auth_secret : dikirim ke Supabase sebagai "password" (password asli tidak pernah keluar browser)
//   wrap_key    : mengunci backup kunci privat, tidak pernah keluar browser
// OWASP ASVS V6: algoritma standar, library teraudit (@noble), CSPRNG untuk kunci dan nonce.
// Rincian: doc/keamanan-password-transport.md

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
const INFO_AUTH = 'seru24/v1/auth'
const INFO_KEYWRAP = 'seru24/v1/keywrap'
const AAD_BACKUP = 'seru24/v1/backup'
/** Parameter scrypt untuk password; disimpan juga di key_backups.kdf_params sebagai catatan. */
export const SCRYPT_PARAMS = { N: 2 ** 15, r: 8, p: 1 } as const
export const AUTH_SALT_BYTES = 16

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

/** Base64url tanpa padding (RFC 4648 bagian 5), aman untuk URL dan format compact. */
export const toBase64Url = (bytes: Uint8Array): string =>
  toBase64(bytes).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '')

export const fromBase64Url = (value: string): Uint8Array => {
  const base64 = value.replaceAll('-', '+').replaceAll('_', '/')
  return fromBase64(base64 + '='.repeat((4 - (base64.length % 4)) % 4))
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

export interface PasswordSecrets {
  /** Dikirim ke Supabase sebagai password (base64url 43 karakter). */
  authSecret: string
  /** Kunci pembungkus backup kunci privat; hanya di memori browser. */
  wrapKey: Uint8Array
}

export type ScryptFn = (
  password: Uint8Array,
  salt: Uint8Array,
  params: { N: number; r: number; p: number; dkLen: number },
) => Promise<Uint8Array>

let scryptImpl: ScryptFn = (password, salt, params) => scryptAsync(password, salt, params)

/** Mobile memasang scrypt native: Hermes tanpa JIT terlalu lambat untuk scrypt JavaScript. */
export const setScryptImplementation = (fn: ScryptFn) => {
  scryptImpl = fn
}

/** Salt acak per akun, dibuat saat daftar dan disimpan server (bukan rahasia). */
export const newAuthSalt = (): string => toBase64(randomBytes(AUTH_SALT_BYTES))

/**
 * Satu password, dua kunci yang tidak saling bisa diturunkan:
 * server hanya pernah melihat authSecret, sehingga tidak bisa menghitung wrapKey maupun password asli.
 */
export const derivePasswordSecrets = async (password: string, authSalt: string): Promise<PasswordSecrets> => {
  const master = await scryptImpl(utf8ToBytes(password.normalize('NFKC')), fromBase64(authSalt), {
    ...SCRYPT_PARAMS,
    dkLen: KEY_BYTES,
  })
  try {
    return {
      authSecret: toBase64Url(hkdf(sha256, master, undefined, utf8ToBytes(INFO_AUTH), KEY_BYTES)),
      wrapKey: hkdf(sha256, master, undefined, utf8ToBytes(INFO_KEYWRAP), KEY_BYTES),
    }
  } finally {
    master.fill(0)
  }
}

/** Bungkus semua versi kunci privat dengan wrapKey sebelum dikirim ke server. */
export const createKeyBackup = (keyring: SecretKeyring, wrapKey: Uint8Array, userId: string, authSalt: string): KeyBackup => {
  const plain = Object.fromEntries(Object.entries(keyring).map(([v, k]) => [v, toBase64(k)]))
  const sealed = seal(wrapKey, utf8ToBytes(JSON.stringify(plain)), utf8ToBytes(`${AAD_BACKUP}|${userId}`))
  return {
    encrypted_keys: sealed.ciphertext,
    nonce: sealed.nonce,
    kdf: 'scrypt',
    kdf_params: { salt: authSalt, ...SCRYPT_PARAMS },
  }
}

/** wrapKey salah (password berbeda) atau data diubah = exception. */
export const openKeyBackup = (backup: KeyBackup, wrapKey: Uint8Array, userId: string): SecretKeyring => {
  const plain = JSON.parse(
    utf8Decode(open(wrapKey, { ciphertext: backup.encrypted_keys, nonce: backup.nonce }, utf8ToBytes(`${AAD_BACKUP}|${userId}`))),
  ) as Record<string, string>
  return Object.fromEntries(Object.entries(plain).map(([v, k]) => [v, fromBase64(k)]))
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
