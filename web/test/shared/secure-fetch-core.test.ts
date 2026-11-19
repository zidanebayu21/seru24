import { describe, expect, it, vi } from 'vitest'
import { x25519 } from '@noble/curves/ed25519.js'
import { toBase64Url } from '../../shared/crypto'
import { sealResponse, transportKeyId } from '../../shared/transport'
import {
  createSecureFetch,
  errorMessage,
  SecureFetchError,
  type HttpAdapter,
} from '../../shared/secure-fetch-core'

describe('secure-fetch-core', () => {
  const server = x25519.keygen()
  const keyId = transportKeyId(server.publicKey)

  it('mengirim payload terenkripsi dan membuka respon terenkripsi', async () => {
    const http: HttpAdapter = {
      getJson: vi.fn(async () => ({
        key_id: keyId,
        public_key: toBase64Url(server.publicKey),
      })),
      postText: vi.fn(async (_path: string, body: string) => {
        const { openRequest } = await import('../../shared/transport')
        const opened = openRequest(body, server.secretKey, keyId)
        const sealedRes = sealResponse({ ok: true, echo: opened.payload }, opened.keyRes, opened.requestId)
        return { status: 200, text: sealedRes }
      }),
    }

    const secureFetch = createSecureFetch(http)
    const result = await secureFetch<{ ok: boolean; echo: any }>('/api/auth/login', { username: 'test' })
    expect(result.ok).toBe(true)
    expect(result.echo).toEqual({ username: 'test' })
    expect(http.getJson).toHaveBeenCalledTimes(1)
  })

  it('mencoba ulang sekali bila server merespons kunci berganti (rotasi)', async () => {
    let callCount = 0
    const http: HttpAdapter = {
      getJson: vi.fn(async () => ({
        key_id: keyId,
        public_key: toBase64Url(server.publicKey),
      })),
      postText: vi.fn(async (_path: string, body: string) => {
        callCount++
        if (callCount === 1) {
          return {
            status: 400,
            text: JSON.stringify({ statusMessage: 'Permintaan terenkripsi tidak valid' }),
          }
        }
        const { openRequest } = await import('../../shared/transport')
        const opened = openRequest(body, server.secretKey, keyId)
        return {
          status: 200,
          text: sealResponse({ successAfterRetry: true }, opened.keyRes, opened.requestId),
        }
      }),
    }

    const secureFetch = createSecureFetch(http)
    const res = await secureFetch<{ successAfterRetry: boolean }>('/api/auth/login', {})
    expect(res.successAfterRetry).toBe(true)
    expect(callCount).toBe(2)
  })

  it('melempar SecureFetchError saat menerima status error selain rotasi', async () => {
    const http: HttpAdapter = {
      getJson: vi.fn(async () => ({ key_id: keyId, public_key: toBase64Url(server.publicKey) })),
      postText: vi.fn(async () => ({
        status: 403,
        text: JSON.stringify({ statusMessage: 'Akses ditolak', data: { log_id: 'err-403' } }),
      })),
    }

    const secureFetch = createSecureFetch(http)
    await expect(secureFetch('/api/auth/login')).rejects.toThrow(SecureFetchError)
  })

  it('memformat pesan error dengan benar via errorMessage helper', () => {
    expect(errorMessage(new SecureFetchError(403, { statusMessage: 'Tidak ada izin' }), 'Gagal')).toBe('Tidak ada izin')
    expect(errorMessage(new SecureFetchError(403, { statusMessage: 'Tidak ada izin', data: { log_id: '123' } }), 'Gagal'))
      .toBe('Tidak ada izin (kode log: 123)')
    expect(errorMessage({ statusCode: 429 }, 'Default')).toBe('Terlalu banyak percobaan. Tunggu sebentar.')
    expect(errorMessage(null, 'Fallback default')).toBe('Fallback default')
  })
})
