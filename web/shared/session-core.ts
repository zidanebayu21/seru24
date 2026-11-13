// Sesi login bersama web dan mobile. Access token hanya di memori; refresh token di cookie httpOnly
// yang dikelola server /api/auth/* (OWASP ASVS V3.2, V3.4).
// Password tidak pernah dikirim: dari password diturunkan auth_secret (ke server) dan wrap_key (tetap di klien).

import { derivePasswordSecrets, newAuthSalt } from './crypto'

export interface SessionResponse {
  access_token: string
  expires_at: number
  user_id: string
}

export interface RegisterInput {
  email: string
  password: string
  username: string
  display_name: string
}

/** POST terenkripsi transport (shared/transport.ts) ke server. */
export type SecurePost = <T>(path: string, payload?: Record<string, unknown>) => Promise<T>

/** Menerima wrap_key + salt dari password yang baru diketik, untuk membuat/membuka kunci chat. */
export type KeyMaterialSink = (wrapKey: Uint8Array, salt: string) => void

const REFRESH_MARGIN_MS = 30_000

export const createSessionCore = (post: SecurePost, onKeyMaterial: KeyMaterialSink) => {
  let accessToken: string | null = null
  let expiresAtMs = 0
  let refreshing: Promise<boolean> | null = null

  const applySession = (session: SessionResponse) => {
    accessToken = session.access_token
    expiresAtMs = session.expires_at * 1000
  }

  const clearLocalSession = () => {
    accessToken = null
    expiresAtMs = 0
  }

  const refreshSession = (): Promise<boolean> => {
    refreshing ??= post<SessionResponse>('/api/auth/refresh')
      .then((session) => {
        applySession(session)
        return true
      })
      .catch(() => {
        clearLocalSession()
        return false
      })
      .finally(() => {
        refreshing = null
      })
    return refreshing
  }

  const getAccessToken = async (): Promise<string | null> => {
    if (accessToken && Date.now() < expiresAtMs - REFRESH_MARGIN_MS) return accessToken
    return (await refreshSession()) ? accessToken : null
  }

  /** identifier = email atau username. */
  const loginWithPassword = async (identifier: string, password: string) => {
    const { salt } = await post<{ salt: string }>('/api/auth/prelogin', { identifier })
    const secrets = await derivePasswordSecrets(password, salt)
    try {
      applySession(await post<SessionResponse>('/api/auth/login', { identifier, auth_secret: secrets.authSecret }))
      onKeyMaterial(secrets.wrapKey, salt)
    } catch (error) {
      secrets.wrapKey.fill(0)
      throw error
    }
  }

  const registerAccount = async (input: RegisterInput) => {
    const salt = newAuthSalt()
    const secrets = await derivePasswordSecrets(input.password, salt)
    const result = await post<{ status: 'active' | 'verify_email' } & Partial<SessionResponse>>('/api/auth/register', {
      email: input.email,
      username: input.username,
      display_name: input.display_name,
      auth_secret: secrets.authSecret,
      auth_salt: salt,
    })
    if (result.status === 'active') {
      applySession(result as SessionResponse)
      onKeyMaterial(secrets.wrapKey, salt)
    } else {
      secrets.wrapKey.fill(0)
    }
    return result.status
  }

  const logoutSession = async () => {
    const token = accessToken
    clearLocalSession()
    await post('/api/auth/logout', token ? { access_token: token } : {}).catch(() => undefined)
  }

  return { clearLocalSession, refreshSession, getAccessToken, loginWithPassword, registerAccount, logoutSession }
}
