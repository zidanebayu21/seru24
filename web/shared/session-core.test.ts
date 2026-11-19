import { describe, expect, it } from 'vitest'
import { SecureFetchError } from './secure-fetch-core'
import { createSessionCore, isNetworkError, type SecurePost } from './session-core'

describe('isNetworkError', () => {
  it('jaringan putus atau server 5xx dianggap offline (sesi tidak dibuang)', () => {
    expect(isNetworkError(new TypeError('Network request failed'))).toBe(true)
    expect(isNetworkError(new Error('Failed to fetch'))).toBe(true)
    expect(isNetworkError(new SecureFetchError(503, null))).toBe(true)
  })

  it('sesi ditolak server bukan masalah jaringan', () => {
    expect(isNetworkError(new SecureFetchError(401, null))).toBe(false)
    expect(isNetworkError(new SecureFetchError(400, null))).toBe(false)
    expect(isNetworkError(new Error('JWT expired'))).toBe(false)
  })
})

describe('refresh token cadangan (native)', () => {
  const session = { access_token: 'at', expires_at: Math.floor(Date.now() / 1000) + 3600, user_id: 'u1' }

  const memoryStore = (initial: string | null) => {
    let value = initial
    return {
      get: () => value,
      store: {
        load: async () => value,
        save: async (token: string) => { value = token },
        clear: async () => { value = null },
      },
    }
  }

  it('cookie hilang: kirim token dari penyimpanan lalu simpan token hasil rotasi', async () => {
    const { get, store } = memoryStore('old-token')
    const calls: Array<Record<string, unknown> | undefined> = []
    const core = createSessionCore(
      (async (_path: string, payload?: Record<string, unknown>) => {
        calls.push(payload)
        return { ...session, refresh_token: 'new-token' }
      }) as SecurePost,
      () => undefined,
      store,
    )
    expect(await core.getAccessToken()).toBe('at')
    expect(calls[0]).toEqual({ native: true, refresh_token: 'old-token' })
    expect(get()).toBe('new-token')
  })

  it('sesi ditolak server: token tersimpan dibuang; jaringan putus: dipertahankan', async () => {
    const rejected = memoryStore('old-token')
    const denied = createSessionCore((async () => { throw new SecureFetchError(401, null) }) as SecurePost, () => undefined, rejected.store)
    expect(await denied.getAccessToken()).toBeNull()
    expect(rejected.get()).toBeNull()

    const offline = memoryStore('old-token')
    const down = createSessionCore((async () => { throw new TypeError('Network request failed') }) as SecurePost, () => undefined, offline.store)
    expect(await down.getAccessToken()).toBeNull()
    expect(down.wasOffline()).toBe(true)
    expect(offline.get()).toBe('old-token')
  })

  it('web (tanpa penyimpanan) tidak meminta token di body', async () => {
    const calls: Array<Record<string, unknown> | undefined> = []
    const core = createSessionCore((async (_path: string, payload?: Record<string, unknown>) => { calls.push(payload); return session }) as SecurePost, () => undefined)
    await core.getAccessToken()
    expect(calls[0]).toEqual({})
  })
})
