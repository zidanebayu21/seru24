import { describe, expect, it } from 'vitest'
import { appendConversations, cacheableConversations, listConversationsArgs, type Conversation } from './chat-core'

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
