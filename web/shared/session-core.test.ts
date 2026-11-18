import { describe, expect, it } from 'vitest'
import { SecureFetchError } from './secure-fetch-core'
import { isNetworkError } from './session-core'

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
