import { describe, expect, it } from 'vitest'
import {
  NEARBY_INBOX_LIMIT,
  addToNearbyInbox,
  clampCreatedAt,
  encodeNearbyAck,
  encodeNearbyMessage,
  nearbyAsMessage,
  nearbyTag,
  parseNearbyWire,
} from '../../shared/nearby-core'
import type { ChatMessage } from '../../shared/e2ee-core'

const params = {
  p_client_msg_id: 'msg-1',
  p_ciphertext: 'Y2lwaGVy',
  p_nonce: 'bm9uY2U=',
  p_sender_key_version: 1,
  p_recipient_key_version: 2,
  p_reply_to: null,
}

describe('nearbyTag', () => {
  it('stabil, pendek, dan berbeda per akun dan percakapan', () => {
    const tag = nearbyTag('conv', 'u1')
    expect(tag).toMatch(/^[0-9a-f]{16}$/)
    expect(nearbyTag('conv', 'u1')).toBe(tag)
    expect(nearbyTag('conv', 'u2')).not.toBe(tag)
    expect(nearbyTag('conv2', 'u1')).not.toBe(tag)
  })
})

describe('encode dan parse', () => {
  it('pesan bolak-balik utuh dan tidak membawa sender_id atau conversation_id', () => {
    const raw = encodeNearbyMessage(params, '2026-11-19T10:00:00.000Z')
    expect(raw).not.toContain('sender_id')
    expect(raw).not.toContain('conversation_id')
    const wire = parseNearbyWire(raw)
    expect(wire).toMatchObject({ t: 'msg', m: { client_msg_id: 'msg-1', ciphertext: 'Y2lwaGVy', sender_key_version: 1, recipient_key_version: 2, reply_to: null } })
  })

  it('ack bolak-balik', () => {
    expect(parseNearbyWire(encodeNearbyAck('msg-1'))).toEqual({ t: 'ack', id: 'msg-1' })
  })

  it.each([
    ['bukan JSON', '{oops'],
    ['bukan objek', '"teks"'],
    ['tipe asing', '{"t":"x"}'],
    ['ack tanpa id', '{"t":"ack"}'],
    ['pesan tanpa isi', '{"t":"msg","m":{}}'],
    ['versi kunci tidak sah', JSON.stringify({ t: 'msg', m: { client_msg_id: 'a', ciphertext: 'b', nonce: 'c', sender_key_version: 0, recipient_key_version: 1, created_at: 'x' } })],
    ['ciphertext terlalu besar', JSON.stringify({ t: 'msg', m: { client_msg_id: 'a', ciphertext: 'x'.repeat(20_000), nonce: 'c', sender_key_version: 1, recipient_key_version: 1, created_at: 'x' } })],
  ])('menolak %s', (_name, raw) => {
    expect(parseNearbyWire(raw)).toBeNull()
  })

  it('menolak payload yang terlalu panjang', () => {
    expect(parseNearbyWire('x'.repeat(40_000))).toBeNull()
  })
})

describe('nearbyAsMessage', () => {
  it('id percakapan dan pengirim ditentukan penerima, seq 0', () => {
    const wire = parseNearbyWire(encodeNearbyMessage(params, '2026-11-19T10:00:00.000Z'))
    if (wire?.t !== 'msg') throw new Error('harus pesan')
    const message = nearbyAsMessage(wire.m, 'conv-1', 'peer-1', Date.parse('2026-11-19T11:00:00Z'))
    expect(message).toMatchObject({ conversation_id: 'conv-1', sender_id: 'peer-1', seq: 0, kind: 'text', id: 'msg-1', created_at: '2026-11-19T10:00:00.000Z' })
  })
})

describe('clampCreatedAt', () => {
  const now = Date.parse('2026-11-19T10:00:00Z')
  it('memakai jam penerima bila waktu dari masa depan atau rusak', () => {
    expect(clampCreatedAt('2030-01-01T00:00:00Z', now)).toBe('2026-11-19T10:00:00.000Z')
    expect(clampCreatedAt('bukan tanggal', now)).toBe('2026-11-19T10:00:00.000Z')
  })
  it('mempertahankan waktu wajar', () => {
    expect(clampCreatedAt('2026-11-19T09:00:00Z', now)).toBe('2026-11-19T09:00:00.000Z')
  })
})

describe('addToNearbyInbox', () => {
  const msg = (id: string) => ({ client_msg_id: id }) as ChatMessage
  it('tanpa duplikat', () => {
    expect(addToNearbyInbox([msg('a')], msg('a'))).toHaveLength(1)
  })
  it('membuang yang tertua bila melebihi batas', () => {
    const full = Array.from({ length: NEARBY_INBOX_LIMIT }, (_, i) => msg(`m${i}`))
    const next = addToNearbyInbox(full, msg('baru'))
    expect(next).toHaveLength(NEARBY_INBOX_LIMIT)
    expect(next[0]!.client_msg_id).toBe('m1')
    expect(next.at(-1)!.client_msg_id).toBe('baru')
  })
})
