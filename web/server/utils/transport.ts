import { x25519 } from '@noble/curves/ed25519.js'
import type { H3Event } from 'h3'
import { fromBase64 } from '#shared/crypto'
import { openRequest, sealResponse, transportKeyId } from '#shared/transport'

// Enkripsi payload browser <-> server (doc/keamanan-password-transport.md), pola gaspro DecryptRequestBodyMiddleware.

const MAX_ENVELOPE_LENGTH = 16_384
const REPLAY_WINDOW_SECONDS = 60
const REPLAY_CACHE_MAX = 10_000

interface TransportKeys {
  secretKey: Uint8Array
  publicKey: Uint8Array
  keyId: string
}

interface SecureContext {
  keyRes: Uint8Array
  requestId: string
}

let keys: TransportKeys | null = null
// request_id yang sudah dipakai, per instance server; jendela waktu membatasi sisanya
const seenRequests = new Map<string, number>()

export const transportKeys = (event: H3Event): TransportKeys => {
  if (keys) return keys
  const raw = useRuntimeConfig(event).transportPrivateKey
  if (!raw) throw new Error('Konfigurasi belum lengkap: NUXT_TRANSPORT_PRIVATE_KEY kosong')
  const secretKey = fromBase64(String(raw))
  const publicKey = x25519.getPublicKey(secretKey)
  keys = { secretKey, publicKey, keyId: transportKeyId(publicKey) }
  return keys
}

const rejectEnvelope = (reason: string) =>
  createError({ statusCode: 400, statusMessage: 'Permintaan terenkripsi tidak valid', cause: new Error(reason) })

const rememberRequest = (requestId: string, timestamp: number) => {
  const now = Math.floor(Date.now() / 1000)
  if (Math.abs(now - timestamp) > REPLAY_WINDOW_SECONDS) throw rejectEnvelope('stale timestamp')
  if (seenRequests.has(requestId)) throw rejectEnvelope('replayed request_id')
  seenRequests.set(requestId, now)
  if (seenRequests.size > REPLAY_CACHE_MAX) {
    for (const [id, at] of seenRequests) {
      if (now - at > REPLAY_WINDOW_SECONDS) seenRequests.delete(id)
    }
  }
}

/** Buka body terenkripsi; payload polos ditolak (tidak ada jalur tanpa enkripsi). */
export const readSecureBody = async (event: H3Event): Promise<Record<string, unknown>> => {
  const raw = await readRawBody(event, 'utf8')
  if (!raw || raw.length > MAX_ENVELOPE_LENGTH) throw rejectEnvelope('missing or oversized envelope')

  const { secretKey, keyId } = transportKeys(event)
  let opened
  try {
    opened = openRequest(raw, secretKey, keyId)
  } catch (error) {
    throw rejectEnvelope(error instanceof Error ? error.message : 'decrypt failed')
  }
  rememberRequest(opened.requestId, opened.timestamp)
  event.context.secure = { keyRes: opened.keyRes, requestId: opened.requestId } satisfies SecureContext

  const payload = opened.payload
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) throw rejectEnvelope('payload is not an object')
  return payload as Record<string, unknown>
}

export const secureResponse = (event: H3Event, payload: unknown): string => {
  const context = event.context.secure as SecureContext | undefined
  if (!context) throw new Error('secureResponse dipanggil tanpa readSecureBody')
  setResponseHeader(event, 'content-type', 'text/plain; charset=utf-8')
  setResponseHeader(event, 'cache-control', 'no-store')
  try {
    return sealResponse(payload, context.keyRes, context.requestId)
  } finally {
    context.keyRes.fill(0)
  }
}

/**
 * Endpoint dengan body dan jawaban terenkripsi: cek Origin, buka envelope, jalankan handler,
 * bungkus jawaban. Error tetap JSON polos tanpa data sensitif.
 */
export const defineSecureHandler = <T>(
  handler: (event: H3Event, payload: Record<string, unknown>) => Promise<T>,
  options: LoggedHandlerOptions = {},
) =>
  defineLoggedHandler(async (event) => {
    assertSameOrigin(event)
    const payload = await readSecureBody(event)
    return secureResponse(event, await handler(event, payload))
  }, options)
