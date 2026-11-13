import { describe, expect, it } from 'vitest'
import {
  CHAT_MOBILE_PREFETCH_SCREENS,
  CHAT_PAGE_SIZE,
  CHAT_PREFETCH_OFFSET,
  mergePagedBubbles,
  oldestPersistedSeq,
} from './chat-core'

describe('paginasi pesan', () => {
  it('membatasi 50 pesan per halaman dengan ambang prefetch di sekitar 40', () => {
    expect(CHAT_PAGE_SIZE).toBe(50)
    expect(CHAT_PREFETCH_OFFSET).toBe(10)
    expect(CHAT_MOBILE_PREFETCH_SCREENS).toBe(1)
  })

  it('mengambil seq terkecil dari pesan tersimpan dan mengabaikan pesan pending', () => {
    expect(oldestPersistedSeq([])).toBeNull()
    expect(oldestPersistedSeq([{ key: 'a', seq: 0, pending: true }])).toBeNull()
    expect(oldestPersistedSeq([
      { key: 'a', seq: 51, pending: false },
      { key: 'b', seq: 52, pending: false },
      { key: 'local', seq: 0, pending: true },
    ])).toBe(51)
  })

  it('menggabungkan halaman lama tanpa duplikat dan menjaga urutan naik', () => {
    const older = [
      { key: 'm2', seq: 2, pending: false },
      { key: 'm1', seq: 1, pending: false },
    ]
    const current = [
      { key: 'm2', seq: 2, pending: false },
      { key: 'm3', seq: 3, pending: false },
      { key: 'local', seq: 0, pending: true },
    ]
    expect(mergePagedBubbles(older, current).map((x) => x.key)).toEqual(['m1', 'm2', 'm3', 'local'])
  })
})
