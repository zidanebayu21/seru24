import { describe, expect, it, vi } from 'vitest'
import { generateKeyPair, toBase64 } from '../../shared/crypto'
import { createE2ee, type ChatMessage } from '../../shared/e2ee-core'

describe('e2ee-core', () => {
  const alicePair = generateKeyPair()
  const bobPair = generateKeyPair()

  const aliceMe = { id: 'alice', username: 'alice', display_name: 'Alice', has_keys: true, key_version: 1 }
  const bobMe = { id: 'bob', username: 'bob', display_name: 'Bob', has_keys: true, key_version: 1 }

  const aliceKeyring = { '1': alicePair.secretKey }
  const bobKeyring = { '1': bobPair.secretKey }

  const publicKeysDb: Record<string, any[]> = {
    alice: [{ key_version: 1, public_key: toBase64(alicePair.publicKey), revoked: false }],
    bob: [{ key_version: 1, public_key: toBase64(bobPair.publicKey), revoked: false }],
  }

  const makeE2ee = (userId: 'alice' | 'bob', tofuStore: Map<string, string> = new Map(), cacheStore?: Map<string, string>) => {
    const isAlice = userId === 'alice'
    return createE2ee({
      rpc: vi.fn(async (fn: string, args: any) => {
        if (fn === 'seru24_get_public_keys') return publicKeysDb[args.p_user] || []
        return null
      }),
      getKeyring: () => (isAlice ? aliceKeyring : bobKeyring),
      getMe: () => (isAlice ? aliceMe : bobMe),
      tofu: {
        get: async (k) => tofuStore.get(k) ?? null,
        set: async (k, v) => { tofuStore.set(k, v) },
      },
      publicKeyCache: cacheStore
        ? {
            get: async (k) => cacheStore.get(k) ?? null,
            set: async (k, v) => { cacheStore.set(k, v) },
          }
        : undefined,
    })
  }

  it('enkripsi dan dekripsi pesan teks antara Alice dan Bob', async () => {
    const aliceE2ee = makeE2ee('alice')
    const bobE2ee = makeE2ee('bob')

    const sealed = await aliceE2ee.encryptText('conv-1', 'bob', 'Halo Bob!')
    expect(sealed.p_ciphertext).toBeTruthy()
    expect(sealed.p_nonce).toBeTruthy()

    const msg: ChatMessage = {
      id: 'm1',
      conversation_id: 'conv-1',
      sender_id: 'alice',
      seq: 1,
      client_msg_id: sealed.p_client_msg_id,
      kind: 'text',
      ciphertext: sealed.p_ciphertext,
      nonce: sealed.p_nonce,
      sender_key_version: sealed.p_sender_key_version,
      recipient_key_version: sealed.p_recipient_key_version,
      reply_to: null,
      created_at: new Date().toISOString(),
      edited_at: null,
      deleted_at: null,
      expires_at: null,
    }

    const decrypted = await bobE2ee.decryptText(msg, 'alice')
    expect(decrypted).toBe('Halo Bob!')

    const bobReply = await bobE2ee.encryptText('conv-1', 'alice', 'Halo Alice!')
    const replyMsg: ChatMessage = {
      ...msg,
      id: 'm2',
      sender_id: 'bob',
      client_msg_id: bobReply.p_client_msg_id,
      ciphertext: bobReply.p_ciphertext,
      nonce: bobReply.p_nonce,
      sender_key_version: bobReply.p_sender_key_version,
      recipient_key_version: bobReply.p_recipient_key_version,
    }
    const decryptedReply = await aliceE2ee.decryptText(replyMsg, 'bob')
    expect(decryptedReply).toBe('Halo Alice!')

    expect(await bobE2ee.decryptText({ ...msg, deleted_at: 'now' }, 'alice')).toBeNull()
    expect(await bobE2ee.decryptText({ ...msg, ciphertext: 'tampered' }, 'alice')).toBeNull()
  })

  it('enkripsi dan dekripsi pesan dokumen (file)', async () => {
    const aliceE2ee = makeE2ee('alice')
    const bobE2ee = makeE2ee('bob')

    const file = {
      id: '12345678-1234-1234-1234-123456789abc',
      name: 'catatan.txt',
      size: 50,
      mime: 'text/plain',
      key: 'A'.repeat(43) + '=',
      iv: 'B'.repeat(16),
    }

    const sealedFile = await aliceE2ee.encryptFile('conv-1', 'bob', file)
    const msg: ChatMessage = {
      id: 'm3',
      conversation_id: 'conv-1',
      sender_id: 'alice',
      seq: 2,
      client_msg_id: sealedFile.p_client_msg_id,
      kind: 'file',
      ciphertext: sealedFile.p_ciphertext,
      nonce: sealedFile.p_nonce,
      sender_key_version: sealedFile.p_sender_key_version,
      recipient_key_version: sealedFile.p_recipient_key_version,
      reply_to: null,
      created_at: new Date().toISOString(),
      edited_at: null,
      deleted_at: null,
      expires_at: null,
    }

    const decFile = await bobE2ee.decryptFile(msg, 'alice')
    expect(decFile).toEqual(file)

    const textFallback = await bobE2ee.decryptText(msg, 'alice')
    expect(textFallback).toBe('📎 catatan.txt')
  })

  it('memeriksa status kunci TOFU (ok, changed, missing)', async () => {
    const tofuStore = new Map<string, string>()
    const aliceE2ee = makeE2ee('alice', tofuStore)

    const status1 = await aliceE2ee.checkPeerKey('bob')
    expect(status1.status).toBe('ok')
    if (status1.status !== 'missing') expect(status1.code).toBeTruthy()

    tofuStore.set(`seru24:tofu:alice:bob`, 'kunci-lama-berbeda')
    const status2 = await aliceE2ee.checkPeerKey('bob')
    expect(status2.status).toBe('changed')

    await aliceE2ee.acceptPeerKey('bob')
    const status3 = await aliceE2ee.checkPeerKey('bob')
    expect(status3.status).toBe('ok')

    const statusMissing = await aliceE2ee.checkPeerKey('charlie')
    expect(statusMissing.status).toBe('missing')
  })

  it('menggunakan publicKeyCache saat RPC offline', async () => {
    const cacheStore = new Map<string, string>([
      ['bob', JSON.stringify(publicKeysDb.bob)],
    ])

    const e2ee = createE2ee({
      rpc: vi.fn(async () => { throw new Error('Network error') }),
      getKeyring: () => aliceKeyring,
      getMe: () => aliceMe,
      tofu: { get: async () => null, set: async () => {} },
      publicKeyCache: {
        get: async (k) => cacheStore.get(k) ?? null,
        set: async (k, v) => { cacheStore.set(k, v) },
      },
    })

    const sealed = await e2ee.encryptText('conv-1', 'bob', 'offline message')
    expect(sealed.p_ciphertext).toBeTruthy()

    e2ee.resetE2ee()
  })
})
