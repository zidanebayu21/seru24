import { describe, expect, it } from 'vitest'
import {
  CHAT_MOBILE_PREFETCH_SCREENS,
  CHAT_PAGE_SIZE,
  CHAT_PREFETCH_OFFSET,
  markMessageDeleted,
  mergeCachedMessages,
  mergePagedBubbles,
  oldestPersistedSeq,
  sliceMessagesPage,
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

  it('menggabungkan cache lokal dengan pesan server sambil menjaga hapus lokal', () => {
    const cached = [
      { client_msg_id: 'c1', seq: 1, edited_at: null },
      { client_msg_id: 'c2', seq: 2, edited_at: null },
      { client_msg_id: 'c3', seq: 3, edited_at: null },
    ]
    const incoming = [
      { client_msg_id: 'c3', seq: 3, edited_at: '2026-11-18T00:00:00Z' },
      { client_msg_id: 'c4', seq: 4, edited_at: null },
      { client_msg_id: 'c2', seq: 2, edited_at: null },
    ]
    const deleted = new Set(['c2'])
    const merged = mergeCachedMessages(cached, incoming, deleted, 1)
    expect(merged).toEqual([
      { client_msg_id: 'c3', seq: 3, edited_at: '2026-11-18T00:00:00Z' },
      { client_msg_id: 'c4', seq: 4, edited_at: null },
    ])
  })

  it('pesan gagal terkirim (seq 0) tetap di bawah, tidak naik ke atas riwayat', () => {
    const current = [
      { key: 'gagal', seq: 0, pending: false },
      { key: 'm2', seq: 2, pending: false },
      { key: 'kirim', seq: 0, pending: true },
    ]
    expect(mergePagedBubbles([{ key: 'm1', seq: 1, pending: false }], current).map((x) => x.key))
      .toEqual(['m1', 'm2', 'gagal', 'kirim'])
  })

  it('menandai pesan terhapus dengan mengosongkan isi terenkripsi', () => {
    const msg = { client_msg_id: 'c1', seq: 1, ciphertext: 'abc', nonce: 'n', deleted_at: null }
    expect(markMessageDeleted(msg, '2026-11-18T00:00:00Z')).toEqual({
      client_msg_id: 'c1',
      seq: 1,
      ciphertext: null,
      nonce: null,
      deleted_at: '2026-11-18T00:00:00Z',
    })
    expect(msg.ciphertext).toBe('abc')
  })

  it('memotong halaman pesan lokal untuk muat awal dan scroll ke atas', () => {
    const list = [1, 2, 3, 4, 5].map((seq) => ({ seq }))
    expect(sliceMessagesPage(list, null, 3)).toEqual({
      rows: [{ seq: 3 }, { seq: 4 }, { seq: 5 }],
      hasOlder: true,
    })
    expect(sliceMessagesPage(list, 3, 3)).toEqual({
      rows: [{ seq: 1 }, { seq: 2 }],
      hasOlder: false,
    })
  })
})
