// POST terenkripsi transport (shared/transport.ts) ke /api/auth/*, bersama web dan mobile.
// Masing-masing platform hanya menyediakan adaptor HTTP (fetch relatif di web, URL absolut di mobile).

import { fromBase64Url } from './crypto'
import { openResponse, sealRequest } from './transport'

export interface HttpResult {
  status: number
  text: string
}

export interface HttpAdapter {
  getJson: <T>(path: string) => Promise<T>
  postText: (path: string, body: string) => Promise<HttpResult>
}

export interface ErrorBody {
  statusMessage?: string
  data?: { log_id?: string }
}

/** Bentuk error sama dengan $fetch (statusCode + data) agar errorMessage() berlaku di semua tempat. */
export class SecureFetchError extends Error {
  constructor(readonly statusCode: number, readonly data: ErrorBody | null) {
    super(data?.statusMessage ?? `HTTP ${statusCode}`)
  }
}

const ENVELOPE_REJECTED = 'Permintaan terenkripsi tidak valid'

const parseErrorBody = (text: string): ErrorBody | null => {
  try {
    return JSON.parse(text) as ErrorBody
  } catch {
    return null
  }
}

export const createSecureFetch = (http: HttpAdapter) => {
  let serverKey: Promise<{ keyId: string; publicKey: Uint8Array }> | null = null

  const loadServerKey = () => {
    serverKey ??= http.getJson<{ key_id: string; public_key: string }>('/api/crypto/public-key')
      .then((res) => ({ keyId: res.key_id, publicKey: fromBase64Url(res.public_key) }))
      .catch((error) => {
        serverKey = null
        throw error
      })
    return serverKey
  }

  const secureFetch = async <T>(path: string, payload: Record<string, unknown> = {}, retry = true): Promise<T> => {
    const key = await loadServerKey()
    const sealed = sealRequest(key.publicKey, key.keyId, payload)
    try {
      const res = await http.postText(path, sealed.compact)
      if (res.status >= 400) {
        const body = parseErrorBody(res.text)
        // kunci server berganti (rotasi): ambil ulang sekali lalu coba lagi
        if (retry && body?.statusMessage === ENVELOPE_REJECTED) {
          serverKey = null
          return secureFetch<T>(path, payload, false)
        }
        throw new SecureFetchError(res.status, body)
      }
      return openResponse<T>(res.text, sealed.keyRes, sealed.requestId)
    } finally {
      sealed.keyRes.fill(0)
    }
  }

  return secureFetch
}

/** Pesan yang aman ditampilkan; detail internal tidak pernah diteruskan (OWASP ASVS V7.4.1). */
export const errorMessage = (error: unknown, fallback: string): string => {
  const err = error as { data?: ErrorBody | null; statusCode?: number }
  const message = err?.data?.statusMessage
    || (err?.statusCode === 429 ? 'Terlalu banyak percobaan. Tunggu sebentar.' : fallback)
  const logId = err?.data?.data?.log_id
  return logId ? `${message} (kode log: ${logId})` : message
}
