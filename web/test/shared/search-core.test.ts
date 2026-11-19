import { describe, expect, it } from 'vitest'
import { normalizeForSearch, searchMessages, type SearchableMessage } from '../../shared/search-core'

const message = (key: string, seq: number, text: string | null, deleted = false): SearchableMessage => ({
  key,
  seq,
  createdAt: '2026-11-19T10:00:00Z',
  text,
  deleted,
})

describe('normalizeForSearch', () => {
  it('mengabaikan huruf besar dan tanda diakritik', () => {
    expect(normalizeForSearch('Café ÉCOLE')).toBe('cafe ecole')
  })
})

describe('searchMessages', () => {
  const messages = [
    message('a', 1, 'Halo, besok kita rapat jam 9 ya'),
    message('b', 2, 'Oke siap, rapat dimulai di ruang A'),
    message('c', 3, 'Dokumen sudah dikirim'),
    message('d', 4, 'rapat dibatalkan', true),
    message('e', 5, null),
  ]

  it('mengembalikan pesan yang cocok, terbaru dulu, tanpa pesan dihapus atau kosong', () => {
    const hits = searchMessages(messages, 'rapat')
    expect(hits.map((hit) => hit.key)).toEqual(['b', 'a'])
  })

  it('semua kata harus ada (urutan bebas) dan huruf besar/kecil diabaikan', () => {
    expect(searchMessages(messages, 'JAM rapat').map((hit) => hit.key)).toEqual(['a'])
    expect(searchMessages(messages, 'rapat zzz')).toEqual([])
  })

  it('menyorot kata yang cocok di teks asli, termasuk karakter beraksen', () => {
    const [hit] = searchMessages([message('x', 1, 'Ke café Senin pagi')], 'cafe')
    expect(hit?.match).toBe('café')
    expect(hit?.before).toBe('Ke ')
    expect(hit?.after).toBe(' Senin pagi')
  })

  it('cuplikan dipotong dengan tanda elipsis di kedua sisi untuk teks panjang', () => {
    const long = `${'a'.repeat(80)} target ${'b'.repeat(80)}`
    const [hit] = searchMessages([message('x', 1, long)], 'target')
    expect(hit?.before.startsWith('…')).toBe(true)
    expect(hit?.after.endsWith('…')).toBe(true)
    expect(hit?.match).toBe('target')
  })

  it('kueri kosong tidak menghasilkan apa pun dan batas jumlah hasil dihormati', () => {
    expect(searchMessages(messages, '   ')).toEqual([])
    const many = Array.from({ length: 5 }, (_, i) => message(`m${i}`, i, 'cocok'))
    expect(searchMessages(many, 'cocok', 3)).toHaveLength(3)
  })
})
