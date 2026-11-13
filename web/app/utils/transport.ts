import { fromBase64Url } from '#shared/crypto'
import { openResponse, sealRequest } from '#shared/transport'

// POST terenkripsi ke /api/auth/* (doc/keamanan-password-transport.md); isi tidak terbaca di DevTools Network.

interface ServerKey {
  keyId: string
  publicKey: Uint8Array
}

const ENVELOPE_REJECTED = 'Permintaan terenkripsi tidak valid'

let serverKey: Promise<ServerKey> | null = null

const loadServerKey = () => {
  serverKey ??= $fetch<{ key_id: string; public_key: string }>('/api/crypto/public-key')
    .then((res) => ({ keyId: res.key_id, publicKey: fromBase64Url(res.public_key) }))
    .catch((error) => {
      serverKey = null
      throw error
    })
  return serverKey
}

/** Error berbentuk teks (karena responseType text) diubah ke JSON agar errorMessage() tetap bisa membacanya. */
const normalizeError = (error: unknown) => {
  const err = error as { data?: unknown }
  if (typeof err?.data === 'string') {
    try {
      err.data = JSON.parse(err.data)
    } catch {
      // bukan JSON, biarkan apa adanya
    }
  }
  return error
}

const isEnvelopeRejected = (error: unknown) =>
  (error as { data?: { statusMessage?: string } })?.data?.statusMessage === ENVELOPE_REJECTED

export const secureFetch = async <T>(path: string, payload: Record<string, unknown> = {}, retry = true): Promise<T> => {
  const key = await loadServerKey()
  const sealed = sealRequest(key.publicKey, key.keyId, payload)
  try {
    const raw = await $fetch<string>(path, {
      method: 'POST',
      body: sealed.compact,
      headers: { 'content-type': 'text/plain' },
      responseType: 'text',
    })
    return openResponse<T>(raw, sealed.keyRes, sealed.requestId)
  } catch (error) {
    normalizeError(error)
    // kunci server berganti (rotasi): ambil ulang sekali lalu coba lagi
    if (retry && isEnvelopeRejected(error)) {
      serverKey = null
      return secureFetch<T>(path, payload, false)
    }
    throw error
  } finally {
    sealed.keyRes.fill(0)
  }
}
