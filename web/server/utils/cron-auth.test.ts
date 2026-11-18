import { describe, expect, it } from 'vitest'
import { isCronAuthorized } from './cron-auth'

describe('isCronAuthorized', () => {
  it('menolak semua permintaan bila CRON_SECRET kosong', () => {
    expect(isCronAuthorized('Bearer ', '')).toBe(false)
    expect(isCronAuthorized('Bearer apa-saja', undefined)).toBe(false)
    expect(isCronAuthorized(undefined, '  ')).toBe(false)
  })

  it('hanya menerima header Bearer dengan secret yang sama persis', () => {
    expect(isCronAuthorized('Bearer rahasia-cron', 'rahasia-cron')).toBe(true)
    expect(isCronAuthorized('Bearer rahasia-cro', 'rahasia-cron')).toBe(false)
    expect(isCronAuthorized('Bearer rahasia-cron-x', 'rahasia-cron')).toBe(false)
    expect(isCronAuthorized('rahasia-cron', 'rahasia-cron')).toBe(false)
    expect(isCronAuthorized(undefined, 'rahasia-cron')).toBe(false)
  })
})
