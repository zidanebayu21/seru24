// Access token hanya di memori modul ini (tidak di localStorage/cookie yang terbaca JS).
// Refresh token ada di cookie httpOnly yang dikelola /api/auth/* (OWASP ASVS V3.2, V3.4).

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
  refreshing ??= $fetch<SessionResponse>('/api/auth/refresh', { method: 'POST' })
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

export const loginWithPassword = async (email: string, password: string) => {
  applySession(await $fetch<SessionResponse>('/api/auth/login', { method: 'POST', body: { email, password } }))
}

export const registerAccount = async (input: RegisterInput) => {
  const result = await $fetch<{ status: 'active' | 'verify_email' } & Partial<SessionResponse>>(
    '/api/auth/register',
    { method: 'POST', body: input },
  )
  if (result.status === 'active') applySession(result as SessionResponse)
  return result.status
}

export const logoutSession = async () => {
  const token = accessToken
  clearLocalSession()
  await $fetch('/api/auth/logout', {
    method: 'POST',
    headers: token ? { authorization: `Bearer ${token}` } : {},
  }).catch(() => undefined)
}
