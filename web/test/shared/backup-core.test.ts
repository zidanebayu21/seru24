import { describe, expect, it } from 'vitest'
import { BackupError, exportLocalBackup, groupMessagesByConversation, importLocalBackup, mergeConversations, openBackup, sealBackup, type BackupData, type BackupStore } from '../../shared/backup-core'
import type { Conversation } from '../../shared/chat-core'
import type { ChatMessage } from '../../shared/e2ee-core'

const conversation = (id: string): Conversation => ({
  id, status: 'accepted', requested_by: null, last_message_at: null, unread: 0, muted: false, archived: false,
  pinned: false, peer_id: `peer-${id}`, peer_username: `u${id}`, peer_display_name: `U ${id}`, peer_blocked: false,
})

const message = (conversationId: string, seq: number): ChatMessage => ({
  id: `m${conversationId}${seq}`, conversation_id: conversationId, sender_id: 'a', seq, client_msg_id: `c${conversationId}${seq}`,
  kind: 'text', ciphertext: 'ct', nonce: 'nn', sender_key_version: 1, recipient_key_version: 1, reply_to: null,
  created_at: '2026-01-01T00:00:00Z', edited_at: null, deleted_at: null, expires_at: null,
})

const keyring = { '1': new Uint8Array(32).fill(7) }
const data: BackupData = {
  exportedAt: '2026-11-18T00:00:00Z',
  conversations: [conversation('1')],
  messages: [message('1', 1), message('1', 2)],
}

describe('backup-core', () => {
  it('ekspor lalu impor mengembalikan isi yang sama', () => {
    const text = sealBackup(keyring, 'user-1', data)
    expect(text).not.toContain('peer-1')
    expect(openBackup(keyring, 'user-1', text)).toEqual(data)
  })

  it('menolak akun lain, kunci lain, dan file yang diubah', () => {
    const text = sealBackup(keyring, 'user-1', data)
    expect(() => openBackup(keyring, 'user-2', text)).toThrow(BackupError)
    expect(() => openBackup({ '1': new Uint8Array(32).fill(9) }, 'user-1', text)).toThrow(BackupError)
    const envelope = JSON.parse(text) as { c: string }
    envelope.c = `${envelope.c.slice(0, -4)}AAAA`
    expect(() => openBackup(keyring, 'user-1', JSON.stringify(envelope))).toThrow(BackupError)
    expect(() => openBackup(keyring, 'user-1', 'bukan json')).toThrow(BackupError)
  })

  it('kunci tertua dipakai sehingga rotasi kunci tidak mengunci cadangan lama', () => {
    const text = sealBackup(keyring, 'user-1', data)
    expect(openBackup({ ...keyring, '2': new Uint8Array(32).fill(3) }, 'user-1', text)).toEqual(data)
  })

  it('menggabungkan percakapan tanpa menimpa yang sudah ada dan mengelompokkan pesan', () => {
    const merged = mergeConversations([conversation('1')], [{ ...conversation('1'), unread: 9 }, conversation('2')])
    expect(merged.map((c) => c.id)).toEqual(['1', '2'])
    expect(merged[0]!.unread).toBe(0)
    const groups = groupMessagesByConversation([message('1', 1), message('2', 1), message('1', 2)])
    expect([...groups.keys()]).toEqual(['1', '2'])
    expect(groups.get('1')).toHaveLength(2)
  })

  it('memindahkan riwayat ke perangkat baru tanpa menimpa yang sudah ada', async () => {
    const memory = (conversations: Conversation[], messages: ChatMessage[]): BackupStore => ({
      loadConversations: async () => conversations,
      loadMessages: async (_user, id) => messages.filter((m) => m.conversation_id === id),
      saveConversations: async (_user, list) => { conversations.splice(0, conversations.length, ...list) },
      saveMessages: async (_user, _id, list) => { for (const m of list) if (!messages.some((x) => x.client_msg_id === m.client_msg_id)) messages.push(m) },
    })
    const oldConvs = [conversation('1'), conversation('2')]
    const oldMessages = [message('1', 1), message('2', 1), message('2', 2)]
    const text = await exportLocalBackup(memory(oldConvs, oldMessages), keyring, 'user-1')

    const newConvs = [conversation('3')]
    const newMessages = [message('3', 1)]
    const result = await importLocalBackup(memory(newConvs, newMessages), keyring, 'user-1', text)
    expect(result).toEqual({ conversations: 2, messages: 3 })
    expect(newConvs.map((c) => c.id)).toEqual(['3', '1', '2'])
    expect(newMessages).toHaveLength(4)
  })
})
