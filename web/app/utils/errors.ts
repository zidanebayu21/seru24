/** Ambil pesan yang aman ditampilkan; detail internal (SQL, stack) tidak pernah diteruskan (OWASP ASVS V7.4.1). */
export const errorMessage = (error: unknown, fallback: string): string => {
  const err = error as { data?: { statusMessage?: string }; statusCode?: number }
  if (err?.statusCode === 429) return 'Terlalu banyak percobaan. Tunggu sebentar.'
  return err?.data?.statusMessage || fallback
}
