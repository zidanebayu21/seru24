import { describe, expect, it } from 'vitest'
import { x25519 } from '@noble/curves/ed25519.js'
import { openRequest, openResponse, sealRequest, sealResponse, transportKeyId } from './transport'

const server = x25519.keygen()
const keyId = transportKeyId(server.publicKey)

describe('enkripsi transport', () => {
  it('permintaan dan jawaban terbuka di sisi masing-masing', () => {
    const sealed = sealRequest(server.publicKey, keyId, { identifier: 'john' })
    const opened = openRequest(sealed.compact, server.secretKey, keyId)
    expect(opened.payload).toEqual({ identifier: 'john' })
    expect(opened.requestId).toBe(sealed.requestId)
    expect(Math.abs(opened.timestamp - Date.now() / 1000)).toBeLessThan(5)

    const reply = sealResponse({ ok: true }, opened.keyRes, opened.requestId)
    expect(openResponse(reply, sealed.keyRes, sealed.requestId)).toEqual({ ok: true })
  })

  it('isi tidak terbaca di jaringan', () => {
    const sealed = sealRequest(server.publicKey, keyId, { identifier: 'rahasia-sekali' })
    expect(sealed.compact).not.toContain('rahasia')
  })

  it('ditolak bila key_id berbeda atau kunci server lain', () => {
    const sealed = sealRequest(server.publicKey, keyId, {})
    expect(() => openRequest(sealed.compact, server.secretKey, 'kunci-lain')).toThrow()
    const other = x25519.keygen()
    expect(() => openRequest(sealed.compact, other.secretKey, keyId)).toThrow()
  })

  it('ditolak bila isi diubah', () => {
    const sealed = sealRequest(server.publicKey, keyId, { a: 1 })
    const [id, pub, body] = sealed.compact.split('.')
    const tampered = `${id}.${pub}.${body!.slice(0, -2)}${body!.endsWith('A') ? 'B' : 'A'}${body!.slice(-1)}`
    expect(() => openRequest(tampered, server.secretKey, keyId)).toThrow()
  })

  it('jawaban untuk permintaan lain ditolak', () => {
    const first = sealRequest(server.publicKey, keyId, {})
    const second = sealRequest(server.publicKey, keyId, {})
    const opened = openRequest(first.compact, server.secretKey, keyId)
    const reply = sealResponse({}, opened.keyRes, opened.requestId)
    expect(() => openResponse(reply, second.keyRes, second.requestId)).toThrow()
  })
})
