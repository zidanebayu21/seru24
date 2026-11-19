import { describe, expect, it } from 'vitest'
import { createRateLimiter } from './rate-limiter-core'

describe('createRateLimiter', () => {
  it('menolak permintaan setelah melewati batas dalam satu jendela', () => {
    const hit = createRateLimiter(3, 60_000)
    expect([1, 2, 3].map(() => hit('ip:1.1.1.1', 0).allowed)).toEqual([true, true, true])
    const rejected = hit('ip:1.1.1.1', 10_000)
    expect(rejected.allowed).toBe(false)
    expect(rejected.retryAfterSeconds).toBe(50)
  })

  it('kunci berbeda dihitung terpisah', () => {
    const hit = createRateLimiter(1, 60_000)
    expect(hit('ip:1.1.1.1', 0).allowed).toBe(true)
    expect(hit('ip:2.2.2.2', 0).allowed).toBe(true)
    expect(hit('ip:1.1.1.1', 0).allowed).toBe(false)
  })

  it('jendela baru mengulang hitungan', () => {
    const hit = createRateLimiter(1, 60_000)
    expect(hit('k', 0).allowed).toBe(true)
    expect(hit('k', 1_000).allowed).toBe(false)
    expect(hit('k', 60_000).allowed).toBe(true)
  })

  it('memori dibatasi: kunci tertua dibuang saat melewati maxKeys', () => {
    const hit = createRateLimiter(1, 60_000, 2)
    hit('a', 0)
    hit('b', 1)
    hit('c', 2)
    // 'a' sudah dibuang sehingga dihitung dari nol lagi
    expect(hit('a', 3).allowed).toBe(true)
  })
})
