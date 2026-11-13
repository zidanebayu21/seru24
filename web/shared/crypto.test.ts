import { describe, expect, it } from 'vitest'
import { x25519 } from '@noble/curves/ed25519.js'
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js'
import {
  createKeyBackup,
  decryptMessage,
  derivePasswordSecrets,
  deriveConversationKey,
  encryptMessage,
  generateKeyPair,
  newAuthSalt,
  openKeyBackup,
  safetyCode,
  type MessageContext,
} from './crypto'

const CONVERSATION = '6f1c2a8e-0000-4000-8000-000000000001'
const ALICE = '11111111-1111-4111-8111-111111111111'
const BOB = '22222222-2222-4222-8222-222222222222'

const ctx = (over: Partial<MessageContext> = {}): MessageContext => ({
  conversationId: CONVERSATION,
  senderId: ALICE,
  clientMsgId: '33333333-3333-4333-8333-333333333333',
  kind: 'text',
  ...over,
})

const pairKeys = () => {
  const alice = generateKeyPair()
  const bob = generateKeyPair()
  const aliceKey = deriveConversationKey(alice.secretKey, bob.publicKey, CONVERSATION,
    { userId: ALICE, keyVersion: 1 }, { userId: BOB, keyVersion: 1 })
  const bobKey = deriveConversationKey(bob.secretKey, alice.publicKey, CONVERSATION,
    { userId: BOB, keyVersion: 1 }, { userId: ALICE, keyVersion: 1 })
  return { alice, bob, aliceKey, bobKey }
}

describe('X25519', () => {
  it('cocok dengan vektor uji RFC 7748 bagian 6.1', () => {
    const alicePriv = hexToBytes('77076d0a7318a57d3c16c17251b26645df4c2f87ebc0992ab177fba51db92c2a')
    const bobPub = hexToBytes('de9edb7d7b7dc1b4d35b61c2ece435373f8343c85b78674dadfc7e146f882b4f')
    expect(bytesToHex(x25519.getPublicKey(alicePriv)))
      .toBe('8520f0098930a754748b7ddcb43ef75a0dbf3a0d26381af4eba4a98eaa9b4e6a')
    expect(bytesToHex(x25519.getSharedSecret(alicePriv, bobPub)))
      .toBe('4a5d9d5ba4ce2de1728e3bf480350f25e07e21c947d19e3376f09b3c1e161742')
  })
})

describe('kunci percakapan', () => {
  it('kedua pihak menurunkan kunci yang sama', () => {
    const { aliceKey, bobKey } = pairKeys()
    expect(bytesToHex(aliceKey)).toBe(bytesToHex(bobKey))
  })

  it('percakapan lain menghasilkan kunci lain', () => {
    const { alice, bob, aliceKey } = pairKeys()
    const other = deriveConversationKey(alice.secretKey, bob.publicKey, 'percakapan-lain',
      { userId: ALICE, keyVersion: 1 }, { userId: BOB, keyVersion: 1 })
    expect(bytesToHex(other)).not.toBe(bytesToHex(aliceKey))
  })
})

describe('enkripsi pesan', () => {
  it('pesan terbuka di sisi penerima', () => {
    const { aliceKey, bobKey } = pairKeys()
    const sealed = encryptMessage(aliceKey, { t: 'halo bob' }, ctx())
    expect(decryptMessage<{ t: string }>(bobKey, sealed, ctx()).t).toBe('halo bob')
    expect(sealed.nonce).toHaveLength(16)
  })

  it('nonce selalu baru untuk isi yang sama', () => {
    const { aliceKey } = pairKeys()
    const a = encryptMessage(aliceKey, { t: 'sama' }, ctx())
    const b = encryptMessage(aliceKey, { t: 'sama' }, ctx())
    expect(a.nonce).not.toBe(b.nonce)
    expect(a.ciphertext).not.toBe(b.ciphertext)
  })

  it('ditolak bila konteks (AAD) diubah', () => {
    const { aliceKey, bobKey } = pairKeys()
    const sealed = encryptMessage(aliceKey, { t: 'rahasia' }, ctx())
    expect(() => decryptMessage(bobKey, sealed, ctx({ senderId: BOB }))).toThrow()
    expect(() => decryptMessage(bobKey, sealed, ctx({ conversationId: 'lain' }))).toThrow()
  })

  it('ditolak bila ciphertext diubah', () => {
    const { aliceKey, bobKey } = pairKeys()
    const sealed = encryptMessage(aliceKey, { t: 'rahasia' }, ctx())
    const tampered = { ...sealed, ciphertext: (sealed.ciphertext[0] === 'A' ? 'B' : 'A') + sealed.ciphertext.slice(1) }
    expect(() => decryptMessage(bobKey, tampered, ctx())).toThrow()
  })

  it('pihak ketiga tidak bisa membuka', () => {
    const { bob, aliceKey } = pairKeys()
    const eve = generateKeyPair()
    const eveKey = deriveConversationKey(eve.secretKey, bob.publicKey, CONVERSATION,
      { userId: ALICE, keyVersion: 1 }, { userId: BOB, keyVersion: 1 })
    const sealed = encryptMessage(aliceKey, { t: 'rahasia' }, ctx())
    expect(() => decryptMessage(eveKey, sealed, ctx())).toThrow()
  })
})

describe('password satu untuk login dan kunci', () => {
  it('hasilnya tetap untuk password dan salt yang sama', async () => {
    const salt = newAuthSalt()
    const a = await derivePasswordSecrets('test123', salt)
    const b = await derivePasswordSecrets('test123', salt)
    expect(a.authSecret).toBe(b.authSecret)
    expect(a.authSecret).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(bytesToHex(a.wrapKey)).toBe(bytesToHex(b.wrapKey))
  })

  it('auth_secret tidak membocorkan password maupun wrap_key', async () => {
    const s = await derivePasswordSecrets('test123', newAuthSalt())
    expect(s.authSecret).not.toContain('test123')
    expect(s.authSecret).not.toBe(Buffer.from(s.wrapKey).toString('base64url'))
  })

  it('salt berbeda menghasilkan rahasia berbeda untuk password yang sama', async () => {
    const a = await derivePasswordSecrets('test123', newAuthSalt())
    const b = await derivePasswordSecrets('test123', newAuthSalt())
    expect(a.authSecret).not.toBe(b.authSecret)
  })
})

describe('backup kunci', () => {
  it('terbuka dengan password yang benar dan ditolak dengan password salah', async () => {
    const salt = newAuthSalt()
    const right = await derivePasswordSecrets('test123', salt)
    const wrong = await derivePasswordSecrets('test124', salt)
    const pair = generateKeyPair()
    const backup = createKeyBackup({ 1: pair.secretKey }, right.wrapKey, ALICE, salt)
    expect(bytesToHex(openKeyBackup(backup, right.wrapKey, ALICE)['1']!)).toBe(bytesToHex(pair.secretKey))
    expect(() => openKeyBackup(backup, wrong.wrapKey, ALICE)).toThrow()
    expect(() => openKeyBackup(backup, right.wrapKey, BOB)).toThrow()
  })
})

describe('safety code', () => {
  it('sama dari kedua sisi', () => {
    const { alice, bob } = pairKeys()
    expect(safetyCode(alice.publicKey, bob.publicKey)).toBe(safetyCode(bob.publicKey, alice.publicKey))
  })
})
