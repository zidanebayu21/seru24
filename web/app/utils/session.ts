import { derivePasswordSecrets, newAuthSalt } from '#shared/crypto'

// Access token hanya di memori modul ini (tidak di localStorage/cookie yang terbaca JS).
// Refresh token ada di cookie httpOnly yang dikelola /api/auth/* (OWASP ASVS V3.2, V3.4).
// Password tidak pernah dikirim: browser menurunkan auth_secret (ke server) dan wrap_key (tetap di sini).

interface SessionResponse {
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

const REFRESH_MARGIN_MS = 30_000

let accessToken: string | null = null
let expiresAtMs = 0
let refreshing: Promise<boolean> | null = null

const applySession = (session: SessionResponse) => {
  accessToken = session.access_token
  expiresAtMs = session.expires_at * 1000
}

export const clearLocalSession = () => {
  accessToken = null
  expiresAtMs = 0
}

export const refreshSession = (): Promise<boolean> => {
  refreshing ??= secureFetch<SessionResponse>('/api/auth/refresh')
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

export const getAccessToken = async (): Promise<string | null> => {
  if (accessToken && Date.now() < expiresAtMs - REFRESH_MARGIN_MS) return accessToken
  return (await refreshSession()) ? accessToken : null
}

/** identifier = email atau username. */
export const loginWithPassword = async (identifier: string, password: string) => {
  const { salt } = await secureFetch<{ salt: string }>('/api/auth/prelogin', { identifier })
  const secrets = await derivePasswordSecrets(password, salt)
  try {
    applySession(await secureFetch<SessionResponse>('/api/auth/login', { identifier, auth_secret: secrets.authSecret }))
    setPendingKeyMaterial(secrets.wrapKey, salt)
  } catch (error) {
    secrets.wrapKey.fill(0)
    throw error
  }
}

export const registerAccount = async (input: RegisterInput) => {
  const salt = newAuthSalt()
  const secrets = await derivePasswordSecrets(input.password, salt)
  const result = await secureFetch<{ status: 'active' | 'verify_email' } & Partial<SessionResponse>>('/api/auth/register', {
    email: input.email,
    username: input.username,
    display_name: input.display_name,
    auth_secret: secrets.authSecret,
    auth_salt: salt,
  })
  if (result.status === 'active') {
    applySession(result as SessionResponse)
    setPendingKeyMaterial(secrets.wrapKey, salt)
  } else {
    secrets.wrapKey.fill(0)
  }
  return result.status
}

export const logoutSession = async () => {
  const token = accessToken
  clearLocalSession()
  await secureFetch('/api/auth/logout', token ? { access_token: token } : {}).catch(() => undefined)
}
