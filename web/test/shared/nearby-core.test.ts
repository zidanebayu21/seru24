import { describe, expect, it } from 'vitest'
import {
  NEARBY_INBOX_LIMIT,
  addToNearbyInbox,
  clampCreatedAt,
  buildEndpointName,
  contactTag,
  encodeNearbyAck,
  encodeNearbyHello,
  encodeNearbyMessage,
  matchContact,
  nearbyAsMessage,
  parseEndpointName,
  parseNearbyWire,
  randomAlias,
  shouldInitiate,
  strangerConversationId,
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

describe('nama siaran', () => {
  const tag = contactTag('conv', 'u1')

  it('alias acak tidak memuat username dan berbentuk tetap', () => {
    expect(randomAlias(new Uint8Array([0x4f, 0x2a, 1, 2]))).toBe('Anonim-4F2A')
  })

  it('tag kontak stabil, 8 hex, dan berbeda per akun dan percakapan', () => {
    expect(tag).toMatch(/^[0-9a-f]{8}$/)
    expect(contactTag('conv', 'u1')).toBe(tag)
    expect(contactTag('conv', 'u2')).not.toBe(tag)
    expect(contactTag('conv2', 'u1')).not.toBe(tag)
  })

  it('bolak-balik dan memangkas tag agar muat di batas nama', () => {
    const name = { alias: 'Anonim-4F2A', id: 'aabbccdd', tags: [tag] }
    expect(parseEndpointName(buildEndpointName(name))).toEqual(name)
    const many = Array.from({ length: 30 }, (_, i) => contactTag('c', `u${i}`))
    const built = buildEndpointName({ ...name, tags: many })
    expect(built.length).toBeLessThanOrEqual(100)
    expect(parseEndpointName(built)!.tags.length).toBeGreaterThan(0)
  })

  it.each(['', 'x|y', 's1|Anonim-4F2A|aabbccdd', 's1|budi|aabbccdd|', 's1|Anonim-4F2A|zz|', 's1|Anonim-4F2A|aabbccdd|nothex'])(
    'menolak nama tidak sah %j',
    (raw) => {
      expect(parseEndpointName(raw)).toBeNull()
    },
  )

  it('mengenali kontak dari tag, orang asing tidak cocok', () => {
    const contacts = [{ conversationId: 'conv', peerId: 'u1' }]
    expect(matchContact([tag], contacts)).toEqual(contacts[0])
    expect(matchContact([contactTag('lain', 'u9')], contacts)).toBeNull()
    expect(matchContact([], contacts)).toBeNull()
  })

  it('hanya satu pihak yang memulai dan id percakapan sementara tidak bergantung urutan', () => {
    expect(shouldInitiate('aaaa', 'bbbb')).toBe(true)
    expect(shouldInitiate('bbbb', 'aaaa')).toBe(false)
    expect(strangerConversationId('u1', 'u2')).toBe(strangerConversationId('u2', 'u1'))
  })
})

describe('hello', () => {
  const hello = { u: 'user-1', n: 'budi_1', k: 1, pk: `${'A'.repeat(43)}=` }

  it('bolak-balik utuh', () => {
    expect(parseNearbyWire(encodeNearbyHello(hello))).toEqual({ t: 'hello', h: hello })
  })

  it.each([
    ['username tidak sah', { ...hello, n: 'Budi!' }],
    ['kunci bukan 32 byte', { ...hello, pk: 'QUJD' }],
    ['versi kunci 0', { ...hello, k: 0 }],
    ['tanpa id', { ...hello, u: '' }],
  ])('menolak %s', (_name, h) => {
    expect(parseNearbyWire(JSON.stringify({ t: 'hello', h }))).toBeNull()
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
