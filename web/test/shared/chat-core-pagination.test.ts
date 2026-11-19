import { describe, expect, it } from 'vitest'
import { appendConversations, cacheableConversations, changedMessages, formatDayLabel, isSameDay, listConversationsArgs, type Conversation } from '../../shared/chat-core'

const conversation = (id: string) => ({ id, peer_id: `peer-${id}`, peer_username: id }) as Conversation

describe('paginasi daftar percakapan', () => {
  it('listConversationsArgs hanya mengirim argumen yang diisi', () => {
    expect(listConversationsArgs()).toEqual({})
    expect(listConversationsArgs({ limit: 50, offset: 100 })).toEqual({ p_limit: 50, p_offset: 100 })
    expect(listConversationsArgs({ id: 'c1' })).toEqual({ p_id: 'c1' })
  })

  it('appendConversations menambah halaman berikutnya tanpa duplikat', () => {
    const merged = appendConversations([conversation('a'), conversation('b')], [conversation('b'), conversation('c')])
    expect(merged.map((c) => c.id)).toEqual(['a', 'b', 'c'])
  })

  it('cache: daftar sebagian mempertahankan yang lama, daftar lengkap menggantikannya', () => {
    const fresh = [conversation('a')]
    const cached = [conversation('a'), conversation('z')]
    expect(cacheableConversations(fresh, cached, true).map((c) => c.id)).toEqual(['a', 'z'])
    expect(cacheableConversations(fresh, cached, false).map((c) => c.id)).toEqual(['a'])
  })
})

describe('label hari di chat', () => {
  const now = new Date(2026, 10, 19, 12, 0)

  it('Hari ini, Kemarin, lalu tanggal; tahun hanya bila bukan tahun ini', () => {
    expect(formatDayLabel(new Date(2026, 10, 19, 8, 0).toISOString(), now)).toBe('Hari ini')
    expect(formatDayLabel(new Date(2026, 10, 18, 23, 0).toISOString(), now)).toBe('Kemarin')
    expect(formatDayLabel(new Date(2026, 10, 3, 9, 0).toISOString(), now)).toBe('3 November')
    expect(formatDayLabel(new Date(2025, 11, 31, 9, 0).toISOString(), now)).toBe('31 Desember 2025')
  })

  it('isSameDay membandingkan tanggal kalender', () => {
    expect(isSameDay(new Date(2026, 10, 19, 1, 0).toISOString(), new Date(2026, 10, 19, 23, 0).toISOString())).toBe(true)
    expect(isSameDay(new Date(2026, 10, 19, 1, 0).toISOString(), new Date(2026, 10, 20, 1, 0).toISOString())).toBe(false)
  })
})

describe('changedMessages', () => {
  const message = (id: string, deleted: string | null = null, edited: string | null = null) => ({ client_msg_id: id, deleted_at: deleted, edited_at: edited })

  it('mengembalikan pesan baru, yang dihapus, dan yang diedit; yang sama diabaikan', () => {
    const known = [message('a'), message('b'), message('c')]
    const fetched = [message('a'), message('b', '2026-11-19T10:00:00Z'), message('c', null, '2026-11-19T10:01:00Z'), message('d')]
    expect(changedMessages(known, fetched).map((m) => m.client_msg_id)).toEqual(['b', 'c', 'd'])
  })

  it('tidak ada perubahan: hasil kosong; deleted_at undefined dianggap sama dengan null', () => {
    expect(changedMessages([message('a')], [message('a')])).toEqual([])
    expect(changedMessages([{ client_msg_id: 'a' }], [message('a')])).toEqual([])
  })
})
