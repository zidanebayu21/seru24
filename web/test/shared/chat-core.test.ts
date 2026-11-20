import { describe, expect, it } from 'vitest'
import {
  CHAT_MOBILE_PREFETCH_SCREENS,
  CHAT_PAGE_SIZE,
  CHAT_PREFETCH_OFFSET,
  bubbleStatus,
  compareBubbles,
  markMessageDeleted,
  messageTime,
  mergeCachedMessages,
  mergePagedBubbles,
  oldestPersistedSeq,
  replySnippet,
  sliceMessagesPage,
} from '../../shared/chat-core'

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

  it('pesan tanpa seq (antrean, diterima langsung) di bawah pesan server dan sesamanya urut waktu', () => {
    const current = [
      { key: 'm1', seq: 1, pending: false, createdAt: '2026-11-19T10:00:00Z' },
      { key: 'kirim-lama', seq: 0, pending: true, createdAt: '2026-11-19T10:05:00Z' },
      { key: 'terima-lama', seq: 0, pending: false, createdAt: '2026-11-19T10:06:00Z' },
    ]
    // pesan baru yang diterima langsung ditambahkan paling depan, tapi tetap tampil paling bawah menurut waktu
    const merged = mergePagedBubbles([{ key: 'terima-baru', seq: 0, pending: false, createdAt: '2026-11-19T10:07:00Z' }], current)
    expect(merged.map((x) => x.key)).toEqual(['m1', 'kirim-lama', 'terima-lama', 'terima-baru'])
    expect(compareBubbles({ key: 'a', seq: 0, pending: false }, { key: 'b', seq: 0, pending: false })).toBe(0)
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

  it('status pesan sendiri: centang satu terkirim, centang dua dibaca', () => {
    const base = { pending: false, failed: '', mine: true, seq: 5, createdAt: new Date().toISOString() }
    expect(bubbleStatus(base, 4)).toMatchObject({ ticks: '✓', read: false })
    expect(bubbleStatus(base, 5)).toMatchObject({ ticks: '✓✓', read: true })
    expect(bubbleStatus({ ...base, mine: false }, 9).ticks).toBe('')
    expect(bubbleStatus({ ...base, pending: true }, 9).text).toBe('mengirim…')
    expect(bubbleStatus({ ...base, failed: 'Gagal' }, 9)).toMatchObject({ text: 'Gagal', ticks: '' })
  })

  it('cuplikan pesan yang dibalas', () => {
    expect(replySnippet({ text: 'halo\n  apa kabar', deleted: false })).toBe('halo apa kabar')
    expect(replySnippet({ text: 'x'.repeat(100), deleted: false })).toHaveLength(81)
    expect(replySnippet({ text: 'rahasia', deleted: true })).toBe('Pesan dihapus')
    expect(replySnippet(null)).toBe('Pesan sebelumnya')
  })
})

describe('pesan revisi (dikirim saat offline)', () => {
  const at = (iso: string) => iso
  it('messageTime memakai waktu kirim offline bila ada', () => {
    expect(messageTime({ created_at: at('2026-11-20T10:05:00Z'), offline_sent_at: at('2026-11-20T09:00:00Z') })).toBe('2026-11-20T09:00:00Z')
    expect(messageTime({ created_at: at('2026-11-20T10:05:00Z'), offline_sent_at: null })).toBe('2026-11-20T10:05:00Z')
  })

  it('pesan revisi tampil menurut waktu kirim aslinya, bukan seq saat sync', () => {
    const lama = { key: 'a', seq: 1, pending: false, createdAt: '2026-11-20T09:00:00Z' }
    const lawan = { key: 'b', seq: 2, pending: false, createdAt: '2026-11-20T09:30:00Z' }
    // dikirim 09:10 saat offline, baru masuk server (seq 3) pukul 10:00
    const revisi = { key: 'c', seq: 3, pending: false, createdAt: '2026-11-20T09:10:00Z', revised: true }
    const baru = { key: 'd', seq: 4, pending: false, createdAt: '2026-11-20T10:01:00Z' }
    expect([baru, revisi, lawan, lama].sort(compareBubbles).map((b) => b.key)).toEqual(['a', 'c', 'b', 'd'])
  })

  it('pesan biasa tetap urut seq dan yang belum tersimpan tetap paling bawah', () => {
    const a = { key: 'a', seq: 5, pending: false, createdAt: '2026-11-20T09:00:00.000000+00:00' }
    const b = { key: 'b', seq: 6, pending: false, createdAt: '2026-11-20T09:00:00.000000+00:00' }
    const antre = { key: 'q', seq: 0, pending: true, createdAt: '2026-11-20T08:00:00Z' }
    expect([antre, b, a].sort(compareBubbles).map((x) => x.key)).toEqual(['a', 'b', 'q'])
  })
})
