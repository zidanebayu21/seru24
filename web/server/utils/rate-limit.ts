import { createHash } from 'node:crypto'
import type { H3Event } from 'h3'
import { createRateLimiter } from './rate-limiter-core'

// Batas laju per menit: sudah login = per pengguna + IP, belum login = per IP (lebih ketat di /api/auth/*).
// Pengguna dikenali hanya dari access token yang diverifikasi Supabase; token palsu atau kedaluwarsa dihitung
// sebagai belum login, sehingga tidak bisa dipakai untuk memperoleh batas yang lebih longgar.
// Penyimpanan di memori per instance (serverless): batas efektif per instance, bukan global.
// Rujukan: OWASP ASVS V11.1.4 (anti-automation), V2.2.1; RFC 6585 §4.
const WINDOW_MS = 60_000
const LOGGED_IN_LIMIT = 1000
const ANONYMOUS_LIMIT = 50
// login, daftar, lupa password: percobaan tanpa sesi dibatasi ketat (OWASP ASVS V2.2.1)
const ANONYMOUS_AUTH_LIMIT = 10

/** Batas yang berlaku, untuk ditampilkan di laporan (email cron). */
export const RATE_LIMITS = {
  loggedInPerMinute: LOGGED_IN_LIMIT,
  anonymousPerMinute: ANONYMOUS_LIMIT,
  anonymousAuthPerMinute: ANONYMOUS_AUTH_LIMIT,
}

const loggedInHit = createRateLimiter(LOGGED_IN_LIMIT, WINDOW_MS)
const anonymousHit = createRateLimiter(ANONYMOUS_LIMIT, WINDOW_MS)
const anonymousAuthHit = createRateLimiter(ANONYMOUS_AUTH_LIMIT, WINDOW_MS)

// Hasil verifikasi token disimpan sebentar agar tiap permintaan tidak memanggil Supabase dua kali.
const IDENTITY_TTL_MS = 60_000
const IDENTITY_CACHE_MAX = 5_000
const identities = new Map<string, { userId: string | null; expiresAt: number }>()

const verifiedUserId = async (event: H3Event, token: string): Promise<string | null> => {
  const cacheKey = createHash('sha256').update(token).digest('hex')
  const now = Date.now()
  const cached = identities.get(cacheKey)
  if (cached && cached.expiresAt > now) return cached.userId

  const userId = await userFromToken(event, token).then((user) => user.id, () => null)
  if (identities.size >= IDENTITY_CACHE_MAX) identities.delete(identities.keys().next().value as string)
  identities.set(cacheKey, { userId, expiresAt: now + IDENTITY_TTL_MS })
  return userId
}

export const bearerToken = (event: H3Event): string => {
  const header = getRequestHeader(event, 'authorization') ?? ''
  return header.startsWith('Bearer ') ? header.slice('Bearer '.length) : ''
}

/** Lempar 429 bila pemanggil melewati batas; token kosong atau tidak sah = belum login. */
export const enforceRateLimit = async (event: H3Event, token: unknown): Promise<void> => {
  const ip = getRequestIP(event, { xForwardedFor: true }) ?? 'unknown'
  const userId = typeof token === 'string' && token && token.length <= 4096 ? await verifiedUserId(event, token) : null
  const isAuthRoute = getRequestURL(event).pathname.startsWith('/api/auth/')
  const result = userId ? loggedInHit(`${userId}:${ip}`) : (isAuthRoute ? anonymousAuthHit : anonymousHit)(ip)
  if (result.allowed) return

  setResponseHeader(event, 'retry-after', result.retryAfterSeconds)
  throw createError({ statusCode: 429, statusMessage: 'Terlalu banyak permintaan' })
}
