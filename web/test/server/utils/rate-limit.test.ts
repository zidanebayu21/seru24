import { describe, expect, it } from 'vitest'
import {
  RATE_LIMITS,
  bearerToken,
  enforceRateLimit,
} from '../../../server/utils/rate-limit'
import { createMockEvent } from '../../setup'

describe('server rate-limit utils', () => {
  it('menyediakan konfigurasi batas laju (RATE_LIMITS)', () => {
    expect(RATE_LIMITS.loggedInPerMinute).toBe(1000)
    expect(RATE_LIMITS.anonymousPerMinute).toBe(50)
    expect(RATE_LIMITS.anonymousAuthPerMinute).toBe(10)
  })

  it('mengekstrak bearer token dari header authorization', () => {
    const ev1 = createMockEvent({ authorization: 'Bearer secret-token-xyz' })
    expect(bearerToken(ev1)).toBe('secret-token-xyz')

    const ev2 = createMockEvent({ authorization: 'Basic dXNlcjpwYXNz' })
    expect(bearerToken(ev2)).toBe('')

    const ev3 = createMockEvent()
    expect(bearerToken(ev3)).toBe('')
  })

  it('menerapkan batas laju enforceRateLimit', async () => {
    const event = createMockEvent({}, 'https://example.com/api/test')
    await expect(enforceRateLimit(event, null)).resolves.toBeUndefined()
  })
})
