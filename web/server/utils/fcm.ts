import { createSign } from 'node:crypto'

export interface FcmConfig {
  projectId: string
  clientEmail: string
  privateKey: string
}

export interface FcmRuntimeConfig {
  fcmServiceAccountJson?: string
  fcmProjectId?: string
  fcmClientEmail?: string
  fcmPrivateKey?: string
}

interface TokenCache {
  key: string
  accessToken: string
  expiresAtMs: number
}

const FCM_SCOPE = 'https://www.googleapis.com/auth/firebase.messaging'
const OAUTH_TOKEN_URL = 'https://oauth2.googleapis.com/token'
const TOKEN_REFRESH_MARGIN_MS = 60_000

let cachedToken: TokenCache | null = null

const base64Url = (input: Buffer | string) =>
  Buffer.from(input).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')

/** Baca kredensial service account FCM dari runtimeConfig; null bila belum dikonfigurasi. */
export const parseFcmConfig = (raw: FcmRuntimeConfig): FcmConfig | null => {
  if (raw.fcmServiceAccountJson) {
    let parsed: Record<string, unknown>
    try {
      parsed = JSON.parse(raw.fcmServiceAccountJson) as Record<string, unknown>
    } catch {
      throw new Error('Konfigurasi NUXT_FCM_SERVICE_ACCOUNT_JSON bukan JSON yang valid')
    }
    const projectId = typeof parsed.project_id === 'string' ? parsed.project_id.trim() : ''
    const clientEmail = typeof parsed.client_email === 'string' ? parsed.client_email.trim() : ''
    const privateKey = typeof parsed.private_key === 'string' ? parsed.private_key.replace(/\\n/g, '\n').trim() : ''
    if (!projectId || !clientEmail || !privateKey) return null
    return { projectId, clientEmail, privateKey }
  }

  const projectId = (raw.fcmProjectId ?? '').trim()
  const clientEmail = (raw.fcmClientEmail ?? '').trim()
  const privateKey = (raw.fcmPrivateKey ?? '').replace(/\\n/g, '\n').trim()
  if (!projectId || !clientEmail || !privateKey) return null
  return { projectId, clientEmail, privateKey }
}

/** Buat JWT RS256 untuk meminta token OAuth2 Google (FCM HTTP v1). */
export const createServiceAccountJwt = (config: FcmConfig, nowSec = Math.floor(Date.now() / 1000)): string => {
  const header = base64Url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))
  const claims = base64Url(JSON.stringify({
    iss: config.clientEmail,
    scope: FCM_SCOPE,
    aud: OAUTH_TOKEN_URL,
    iat: nowSec,
    exp: nowSec + 3600,
  }))
  const unsigned = `${header}.${claims}`
  const signer = createSign('RSA-SHA256')
  signer.update(unsigned)
  signer.end()
  return `${unsigned}.${base64Url(signer.sign(config.privateKey))}`
}

const getAccessToken = async (config: FcmConfig, fetcher: typeof fetch = fetch): Promise<string> => {
  const cacheKey = `${config.projectId}:${config.clientEmail}`
  if (cachedToken && cachedToken.key === cacheKey && Date.now() < cachedToken.expiresAtMs - TOKEN_REFRESH_MARGIN_MS) {
    return cachedToken.accessToken
  }

  const assertion = createServiceAccountJwt(config)
  const body = new URLSearchParams({
    grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
    assertion,
  })
  const res = await fetcher(OAUTH_TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  })
  if (!res.ok) {
    throw new Error(`OAuth2 FCM gagal (${res.status})`)
  }
  const data = (await res.json()) as { access_token?: string; expires_in?: number }
  if (!data.access_token) {
    throw new Error('Respons OAuth2 FCM tidak berisi access_token')
  }
  cachedToken = {
    key: cacheKey,
    accessToken: data.access_token,
    expiresAtMs: Date.now() + (data.expires_in ?? 3600) * 1000,
  }
  return data.access_token
}

export const resetFcmTokenCache = () => {
  cachedToken = null
}

export interface FcmSendResult {
  token: string
  ok: boolean
  unregistered: boolean
  error?: string
}

const isUnregisteredError = (status: number, bodyText: string): boolean => {
  if (status === 404) return true
  try {
    const parsed = JSON.parse(bodyText) as {
      error?: { status?: string; details?: Array<{ errorCode?: string }> }
    }
    const fcmCode = parsed.error?.details?.find((d) => typeof d.errorCode === 'string')?.errorCode
    if (fcmCode === 'UNREGISTERED' || fcmCode === 'SENDER_ID_MISMATCH') return true
    if (parsed.error?.status === 'NOT_FOUND') return true
  } catch {
    // abaikan body non-JSON
  }
  return false
}

/**
 * Kirim push data-only prioritas tinggi ke satu perangkat via FCM HTTP v1.
 * Isi pesan tidak pernah dikirim (E2EE); aplikasi Android menampilkan "Pesan baru" secara lokal.
 */
export const sendFcmMessage = async (
  config: FcmConfig,
  deviceToken: string,
  conversationId: string,
  fetcher: typeof fetch = fetch,
): Promise<FcmSendResult> => {
  const accessToken = await getAccessToken(config, fetcher)
  const endpoint = `https://fcm.googleapis.com/v1/projects/${encodeURIComponent(config.projectId)}/messages:send`
  const res = await fetcher(endpoint, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${accessToken}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      message: {
        token: deviceToken,
        data: {
          type: 'message_new',
          conversation_id: conversationId,
        },
        android: {
          priority: 'high',
          collapse_key: conversationId,
        },
      },
    }),
  })

  if (res.ok) {
    return { token: deviceToken, ok: true, unregistered: false }
  }
  const bodyText = await res.text().catch(() => '')
  return {
    token: deviceToken,
    ok: false,
    unregistered: isUnregisteredError(res.status, bodyText),
    error: `FCM HTTP ${res.status}`,
  }
}
