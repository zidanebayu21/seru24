// Enkripsi payload browser <-> server Nuxt di atas TLS, pola sama dengan gaspro (EcdheKemEnvelope):
//   shared  = X25519(kunci efemeral klien, kunci publik server)            RFC 7748
//   key_req = HKDF-SHA256(shared, salt = nonce, "seru24-http-enc:req:v1")   RFC 5869
//   key_res = HKDF-SHA256(shared, salt = nonce, "seru24-http-enc:res:v1")
//   isi     = AES-256-GCM, AAD = key_id                                     NIST SP 800-38D
// Permintaan : "<key_id>.<pubkey_efemeral_b64url>.<nonce||ciphertext||tag b64url>"
//              isi = {"request_id","timestamp","payload"} (anti replay)
// Jawaban    : "<nonce||ciphertext||tag b64url>", isi = {"request_id","payload"}
// OWASP ASVS V9.1 (perlindungan data saat transit), V6.2. Rincian: doc/keamanan-password-transport.md

import { x25519 } from '@noble/curves/ed25519.js'
import { hkdf } from '@noble/hashes/hkdf.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex, concatBytes, randomBytes, utf8ToBytes } from '@noble/hashes/utils.js'
import { gcm } from '@noble/ciphers/aes.js'
import { NONCE_BYTES, KEY_BYTES, fromBase64Url, randomId, toBase64Url } from './crypto'

const INFO_REQUEST = 'seru24-http-enc:req:v1'
const INFO_RESPONSE = 'seru24-http-enc:res:v1'
const KEY_ID_HEX = 16
const TAG_BYTES = 16

export interface SealedRequest {
  compact: string
  keyRes: Uint8Array
  requestId: string
}

export interface OpenedRequest {
  payload: unknown
  keyRes: Uint8Array
  requestId: string
  timestamp: number
}

export const transportKeyId = (serverPublicKey: Uint8Array) => bytesToHex(sha256(serverPublicKey)).slice(0, KEY_ID_HEX)

const deriveKeys = (shared: Uint8Array, nonce: Uint8Array) => {
  const keys = {
    keyReq: hkdf(sha256, shared, nonce, utf8ToBytes(INFO_REQUEST), KEY_BYTES),
    keyRes: hkdf(sha256, shared, nonce, utf8ToBytes(INFO_RESPONSE), KEY_BYTES),
  }
  shared.fill(0)
  return keys
}

const splitBody = (blob: Uint8Array) => {
  if (blob.length < NONCE_BYTES + TAG_BYTES) throw new Error('bad body segment')
  return { nonce: blob.subarray(0, NONCE_BYTES), sealed: blob.subarray(NONCE_BYTES) }
}

const decodeJson = (bytes: Uint8Array) => JSON.parse(new TextDecoder().decode(bytes)) as Record<string, unknown>

/** Sisi browser: bungkus payload untuk server. */
export const sealRequest = (serverPublicKey: Uint8Array, keyId: string, payload: unknown): SealedRequest => {
  const ephemeral = x25519.keygen()
  const nonce = randomBytes(NONCE_BYTES)
  const { keyReq, keyRes } = deriveKeys(x25519.getSharedSecret(ephemeral.secretKey, serverPublicKey), nonce)
  ephemeral.secretKey.fill(0)

  const requestId = randomId()
  const inner = utf8ToBytes(JSON.stringify({ request_id: requestId, timestamp: Math.floor(Date.now() / 1000), payload }))
  const sealed = gcm(keyReq, nonce, utf8ToBytes(keyId)).encrypt(inner)
  keyReq.fill(0)

  return {
    compact: `${keyId}.${toBase64Url(ephemeral.publicKey)}.${toBase64Url(concatBytes(nonce, sealed))}`,
    keyRes,
    requestId,
  }
}

/** Sisi browser: buka jawaban server dan pastikan menjawab permintaan yang sama. */
export const openResponse = <T>(raw: string, keyRes: Uint8Array, requestId: string): T => {
  const { nonce, sealed } = splitBody(fromBase64Url(raw.trim()))
  const inner = decodeJson(gcm(keyRes, nonce).decrypt(sealed))
  if (inner.request_id !== requestId) throw new Error('response request_id mismatch')
  return inner.payload as T
}

/** Sisi server: buka permintaan. Kunci salah, data diubah, atau format rusak = exception. */
export const openRequest = (compact: string, serverSecretKey: Uint8Array, expectedKeyId: string): OpenedRequest => {
  const segments = compact.trim().split('.')
  if (segments.length !== 3) throw new Error('malformed compact envelope')
  const [keyId, clientPublicKey, body] = segments as [string, string, string]
  if (keyId !== expectedKeyId) throw new Error('unknown key_id')

  const { nonce, sealed } = splitBody(fromBase64Url(body))
  const { keyReq, keyRes } = deriveKeys(x25519.getSharedSecret(serverSecretKey, fromBase64Url(clientPublicKey)), nonce)
  const inner = decodeJson(gcm(keyReq, nonce, utf8ToBytes(keyId)).decrypt(sealed))
  keyReq.fill(0)

  if (typeof inner.request_id !== 'string' || typeof inner.timestamp !== 'number' || !('payload' in inner)) {
    throw new Error('malformed inner plaintext')
  }
  return { payload: inner.payload, keyRes, requestId: inner.request_id, timestamp: inner.timestamp }
}

/** Sisi server: bungkus jawaban dengan key_res milik permintaan itu. */
export const sealResponse = (payload: unknown, keyRes: Uint8Array, requestId: string): string => {
  const nonce = randomBytes(NONCE_BYTES)
  const sealed = gcm(keyRes, nonce).encrypt(utf8ToBytes(JSON.stringify({ request_id: requestId, payload })))
  return toBase64Url(concatBytes(nonce, sealed))
}
