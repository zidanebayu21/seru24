import { createClient, type Session } from '@supabase/supabase-js'
import { hkdf } from '@noble/hashes/hkdf.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { utf8ToBytes } from '@noble/hashes/utils.js'
import type { H3Event } from 'h3'
import { AUTH_SALT_BYTES, toBase64 } from '#shared/crypto'

// Refresh token hanya di cookie httpOnly; access token dikirim di body dan disimpan di memori halaman.
// OWASP ASVS V3.4.1-V3.4.3 (Secure, HttpOnly, SameSite) dan prefix __Host- (RFC 6265bis).
const REFRESH_COOKIE = '__Host-seru24_rt'
const REFRESH_MAX_AGE = 60 * 60 * 24 * 30

const EMAIL_PATTERN = /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,63}$/
const USERNAME_PATTERN = /^[a-z0-9_]{3,30}$/
// auth_secret = base64url 32 byte; auth_salt = base64 16 byte (shared/crypto.ts)
const AUTH_SECRET_PATTERN = /^[A-Za-z0-9_-]{43}$/
const AUTH_SALT_PATTERN = /^[A-Za-z0-9+/]{22}==$/
const INFO_FAKE_SALT = 'seru24/v1/fake-salt'

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

/** Klien service_role untuk RPC khusus server; null bila kunci belum diisi. Tidak pernah dipakai di browser. */
export const serviceClient = (event: H3Event) => {
  const config = useRuntimeConfig(event)
  if (!config.public.supabaseUrl || !config.supabaseServiceRoleKey) return null
  return createClient(config.public.supabaseUrl, config.supabaseServiceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  })
}

/** Email atau username, dinormalisasi; format lain ditolak 400. */
export const parseIdentifier = (value: unknown) => {
  const identifier = text(value, 254).trim().toLowerCase()
  if (identifier.includes('@')) return parseEmail(identifier)
  if (!USERNAME_PATTERN.test(identifier)) throw badRequest()
  return identifier
}

export interface LoginAccount {
  email: string
  salt: string
}

/** Cari akun aktif dari email atau username (service_role). null = tidak ada / dibanned / dihapus. */
export const findLoginAccount = async (event: H3Event, identifier: string): Promise<LoginAccount | null> => {
  const client = serviceClient(event)
  if (!client) throw new Error('Konfigurasi belum lengkap: NUXT_SUPABASE_SERVICE_ROLE_KEY kosong')
  const { data, error } = await client.rpc('seru24_login_lookup', { p_identifier: identifier })
  if (error) throw new Error(`seru24_login_lookup gagal: ${error.message}`)
  const account = data as Partial<LoginAccount> | null
  return account?.email && account.salt ? { email: account.email, salt: account.salt } : null
}

/**
 * Salt palsu yang tetap untuk identifier tak terdaftar, supaya /prelogin tidak bisa dipakai
 * menebak akun mana yang ada (OWASP ASVS V2.2, enumerasi akun).
 */
export const fakeSalt = (event: H3Event, identifier: string) =>
  toBase64(hkdf(sha256, transportKeys(event).secretKey, undefined, utf8ToBytes(`${INFO_FAKE_SALT}|${identifier}`), AUTH_SALT_BYTES))

export const parseAuthSecret = (value: unknown) => {
  if (typeof value !== 'string' || !AUTH_SECRET_PATTERN.test(value)) throw badRequest()
  return value
}

export const parseAuthSalt = (value: unknown) => {
  if (typeof value !== 'string' || !AUTH_SALT_PATTERN.test(value)) throw badRequest()
  return value
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

export const parseUsername = (value: unknown) => {
  const username = text(value, 30).trim().toLowerCase()
  if (!USERNAME_PATTERN.test(username)) throw badRequest()
  return username
}

export const parseDisplayName = (value: unknown) => text(value ?? '', 50).trim()
