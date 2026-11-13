import { createClient, type Session } from '@supabase/supabase-js'
import type { H3Event } from 'h3'

// Refresh token hanya di cookie httpOnly; access token dikirim di body dan disimpan di memori halaman.
// OWASP ASVS V3.4.1-V3.4.3 (Secure, HttpOnly, SameSite) dan prefix __Host- (RFC 6265bis).
const REFRESH_COOKIE = '__Host-seru24_rt'
const REFRESH_MAX_AGE = 60 * 60 * 24 * 30

const EMAIL_PATTERN = /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,63}$/
const USERNAME_PATTERN = /^[a-z0-9_]{3,30}$/
const PASSWORD_MIN = 12
const PASSWORD_MAX = 128

export interface SessionResponse {
  access_token: string
  expires_at: number
  user_id: string
}

export const authClient = (event: H3Event) => {
  const { supabaseUrl, supabaseAnonKey } = useRuntimeConfig(event).public
  if (!supabaseUrl || !supabaseAnonKey) {
    throw new Error('Konfigurasi belum lengkap: NUXT_PUBLIC_SUPABASE_URL / NUXT_PUBLIC_SUPABASE_ANON_KEY kosong')
  }
  const forwardedFor = getRequestIP(event, { xForwardedFor: true })
  return createClient(supabaseUrl, supabaseAnonKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: { headers: forwardedFor ? { 'x-forwarded-for': forwardedFor } : {} },
  })
}

/** Tolak permintaan lintas situs ke endpoint yang memakai cookie (CSRF, OWASP ASVS V4.2.2). */
export const assertSameOrigin = (event: H3Event) => {
  const origin = getRequestHeader(event, 'origin')
  if (!origin || origin !== getRequestURL(event).origin) {
    throw createError({ statusCode: 403, statusMessage: 'Forbidden' })
  }
}

export const issueSession = (event: H3Event, session: Session): SessionResponse => {
  setCookie(event, REFRESH_COOKIE, session.refresh_token, {
    httpOnly: true,
    secure: true,
    sameSite: 'lax',
    path: '/',
    maxAge: REFRESH_MAX_AGE,
  })
  return {
    access_token: session.access_token,
    expires_at: session.expires_at ?? Math.floor(Date.now() / 1000) + session.expires_in,
    user_id: session.user.id,
  }
}

export const readRefreshToken = (event: H3Event) => getCookie(event, REFRESH_COOKIE)

export const clearRefreshCookie = (event: H3Event) => deleteCookie(event, REFRESH_COOKIE, { path: '/', secure: true })

const badRequest = () => createError({ statusCode: 400, statusMessage: 'Data tidak valid' })

const text = (value: unknown, max: number) => {
  if (typeof value !== 'string' || value.length > max) throw badRequest()
  return value
}

export const parseEmail = (value: unknown) => {
  const email = text(value, 254).trim().toLowerCase()
  if (!EMAIL_PATTERN.test(email)) throw badRequest()
  return email
}

export const parsePassword = (value: unknown) => {
  const password = text(value, PASSWORD_MAX)
  if (password.length < PASSWORD_MIN) throw badRequest()
  return password
}

export const parseUsername = (value: unknown) => {
  const username = text(value, 30).trim().toLowerCase()
  if (!USERNAME_PATTERN.test(username)) throw badRequest()
  return username
}

export const parseDisplayName = (value: unknown) => text(value ?? '', 50).trim()
