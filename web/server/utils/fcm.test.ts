import { generateKeyPairSync, createVerify } from 'node:crypto'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createServiceAccountJwt, parseFcmConfig, resetFcmTokenCache, sendFcmMessage } from './fcm'

const { publicKey, privateKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
})

describe('fcm helper', () => {
  beforeEach(() => {
    resetFcmTokenCache()
  })

  it('membaca konfigurasi dari JSON atau variabel terpisah', () => {
    expect(parseFcmConfig({})).toBeNull()

    const fromJson = parseFcmConfig({
      fcmServiceAccountJson: JSON.stringify({
        project_id: 'seru24-app',
        client_email: 'fcm@seru24-app.iam.gserviceaccount.com',
        private_key: privateKey.replace(/\n/g, '\\n'),
      }),
    })
    expect(fromJson).toEqual({
      projectId: 'seru24-app',
      clientEmail: 'fcm@seru24-app.iam.gserviceaccount.com',
      privateKey: privateKey.trim(),
    })

    const fromFields = parseFcmConfig({
      fcmProjectId: 'seru24-app',
      fcmClientEmail: 'fcm@seru24-app.iam.gserviceaccount.com',
      fcmPrivateKey: privateKey.replace(/\n/g, '\\n'),
    })
    expect(fromFields).toEqual(fromJson)
  })

  it('membuat JWT RS256 yang sah untuk OAuth2 Google', () => {
    const config = {
      projectId: 'seru24-app',
      clientEmail: 'fcm@seru24-app.iam.gserviceaccount.com',
      privateKey,
    }
    const jwt = createServiceAccountJwt(config, 1_700_000_000)
    const [headerB64, claimsB64, sigB64] = jwt.split('.')
    expect(headerB64).toBeTruthy()
    expect(claimsB64).toBeTruthy()
    expect(sigB64).toBeTruthy()

    const claims = JSON.parse(Buffer.from(claimsB64!, 'base64url').toString('utf8'))
    expect(claims).toMatchObject({
      iss: config.clientEmail,
      scope: 'https://www.googleapis.com/auth/firebase.messaging',
      aud: 'https://oauth2.googleapis.com/token',
      iat: 1_700_000_000,
      exp: 1_700_003_600,
    })

    const verifier = createVerify('RSA-SHA256')
    verifier.update(`${headerB64}.${claimsB64}`)
    verifier.end()
    expect(verifier.verify(publicKey, Buffer.from(sigB64!, 'base64url'))).toBe(true)
  })

  it('mengirim payload data-only tanpa isi pesan dan menandai token UNREGISTERED', async () => {
    const config = {
      projectId: 'seru24-app',
      clientEmail: 'fcm@seru24-app.iam.gserviceaccount.com',
      privateKey,
    }

    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({ access_token: 'oauth-tok', expires_in: 3600 }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ name: 'projects/seru24-app/messages/1' }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        error: { status: 'NOT_FOUND', details: [{ errorCode: 'UNREGISTERED' }] },
      }), { status: 404 }))

    const okRes = await sendFcmMessage(config, 'fcm-device-1', 'conv-123', fetcher)
    expect(okRes).toEqual({ token: 'fcm-device-1', ok: true, unregistered: false })

    // panggilan ke-2 memakai access_token dari cache (total fetch: 1 oauth + 2 fcm)
    const failRes = await sendFcmMessage(config, 'fcm-device-2', 'conv-123', fetcher)
    expect(failRes).toEqual({ token: 'fcm-device-2', ok: false, unregistered: true, error: 'FCM HTTP 404' })
    expect(fetcher).toHaveBeenCalledTimes(3)

    const fcmCallBody = JSON.parse(String(fetcher.mock.calls[1]?.[1]?.body))
    expect(fcmCallBody).toEqual({
      message: {
        token: 'fcm-device-1',
        data: { type: 'message_new', conversation_id: 'conv-123' },
        android: { priority: 'high', collapse_key: 'conv-123' },
      },
    })
  })
})
