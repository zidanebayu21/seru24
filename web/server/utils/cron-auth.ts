import { createHash, timingSafeEqual } from 'node:crypto'

const digest = (value: string) => createHash('sha256').update(value, 'utf8').digest()

/**
 * Cek header `Authorization: Bearer <CRON_SECRET>` untuk endpoint cron.
 * Gagal tertutup bila secret belum diset; perbandingan waktu-konstan lewat hash SHA-256
 * agar panjang secret tidak bocor (OWASP ASVS V2.9.1, CWE-208).
 */
export const isCronAuthorized = (authorization: string | undefined, secret: string | undefined): boolean => {
  const expected = String(secret ?? '').trim()
  if (!expected || !authorization?.startsWith('Bearer ')) return false
  return timingSafeEqual(digest(authorization.slice('Bearer '.length)), digest(expected))
}
