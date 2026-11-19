import { describe, expect, it } from 'vitest'
import {
  assertSameOrigin,
  authClient,
  clearRefreshCookie,
  fakeSalt,
  findLoginAccount,
  issueSession,
  parseAuthSalt,
  parseAuthSecret,
  parseBackup,
  parseDisplayName,
  parseEmail,
  parseIdentifier,
  parsePublicKey,
  parseUsername,
  readRefreshToken,
  requireServiceClient,
  serviceClient,
  tokenAuthMethods,
  userFromToken,
  wantsNativeToken,
} from '../../../server/utils/auth'
import { createMockEvent } from '../../setup'

describe('server auth utils', () => {
  it('validasi identifier, email, username, dan display name', () => {
    expect(parseIdentifier('User_123')).toBe('user_123')
    expect(parseIdentifier('test@example.com')).toBe('test@example.com')
    expect(() => parseIdentifier('ab')).toThrow()
    expect(() => parseIdentifier('invalid email@')).toThrow()

    expect(parseEmail('Admin@Example.COM')).toBe('admin@example.com')
    expect(() => parseEmail('not-an-email')).toThrow()

    expect(parseUsername('Valid_User')).toBe('valid_user')
    expect(() => parseUsername('x')).toThrow()

    expect(parseDisplayName(' Budi Santoso ')).toBe('Budi Santoso')
  })

  it('validasi secret, salt, public key, dan backup', () => {
    const validSecret = 'A'.repeat(43)
    expect(parseAuthSecret(validSecret)).toBe(validSecret)
    expect(() => parseAuthSecret('short')).toThrow()

    const validSalt = 'A'.repeat(22) + '=='
    expect(parseAuthSalt(validSalt)).toBe(validSalt)
    expect(() => parseAuthSalt('invalid')).toThrow()

    const validPub = 'A'.repeat(43) + '='
    expect(parsePublicKey(validPub)).toBe(validPub)
    expect(() => parsePublicKey('invalid')).toThrow()

    const backup = parseBackup({
      encrypted_keys: 'A'.repeat(30),
      nonce: 'B'.repeat(16),
    }, validSalt)
    expect(backup.encrypted_keys).toBe('A'.repeat(30))
    expect(backup.nonce).toBe('B'.repeat(16))
    expect((backup.kdf_params as any).salt).toBe(validSalt)
  })

  it('mengekstrak metode autentikasi dari token JWT (amr claims)', () => {
    const claims = { amr: [{ method: 'password' }, { method: 'otp' }] }
    const claimsB64 = Buffer.from(JSON.stringify(claims)).toString('base64url')
    const fakeJwt = `header.${claimsB64}.signature`

    expect(tokenAuthMethods(fakeJwt)).toEqual(['password', 'otp'])
    expect(tokenAuthMethods('invalid.token')).toEqual([])
  })

  it('memvalidasi same origin (CSRF prevention)', () => {
    const validEvent = createMockEvent({ origin: 'https://example.com' }, 'https://example.com/api/test')
    expect(() => assertSameOrigin(validEvent)).not.toThrow()

    const invalidEvent = createMockEvent({ origin: 'https://evil.com' }, 'https://example.com/api/test')
    expect(() => assertSameOrigin(invalidEvent)).toThrow()
  })

  it('menerbitkan session response dan membaca refresh token', () => {
    const event = createMockEvent()
    const mockSession = {
      access_token: 'acc-tok',
      refresh_token: 'ref-tok-12345678',
      expires_at: 1800000000,
      expires_in: 3600,
      user: { id: 'u-123' },
    } as any

    const resWeb = issueSession(event, mockSession, false)
    expect(resWeb.access_token).toBe('acc-tok')
    expect(resWeb.refresh_token).toBeUndefined()

    const resNative = issueSession(event, mockSession, true)
    expect(resNative.refresh_token).toBe('ref-tok-12345678')
    expect(wantsNativeToken({ native: true })).toBe(true)

    expect(readRefreshToken(event, { native: true, refresh_token: 'ref-tok-12345678' })).toBe('ref-tok-12345678')
    clearRefreshCookie(event)
  })

  it('membuat fake salt yang deterministik untuk identitas yang tidak terdaftar', () => {
    const event = createMockEvent()
    const salt1 = fakeSalt(event, 'unknown_user')
    const salt2 = fakeSalt(event, 'unknown_user')
    expect(salt1).toBe(salt2)
    expect(salt1).toHaveLength(24)
  })

  it('menginisialisasi authClient dan serviceClient', () => {
    const event = createMockEvent()
    const client = authClient(event)
    expect(client).toBeDefined()

    const sClient = serviceClient(event)
    expect(sClient).toBeDefined()
    expect(requireServiceClient(event)).toBeDefined()
  })

  it('memeriksa token pengguna dengan userFromToken', async () => {
    const event = createMockEvent()
    await expect(userFromToken(event, '')).rejects.toThrow()
    await expect(userFromToken(event, 'a'.repeat(5000))).rejects.toThrow()
  })
})
