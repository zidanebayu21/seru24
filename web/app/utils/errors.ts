/** Ambil pesan yang aman ditampilkan; detail internal (SQL, stack) tidak pernah diteruskan (OWASP ASVS V7.4.1). */
export const errorMessage = (error: unknown, fallback: string): string => {
  const err = error as { data?: { statusMessage?: string; data?: { log_id?: string } }; statusCode?: number }
  const message = err?.data?.statusMessage
    || (err?.statusCode === 429 ? 'Terlalu banyak percobaan. Tunggu sebentar.' : fallback)
  const logId = err?.data?.data?.log_id
  return logId ? `${message} (kode log: ${logId})` : message
}
