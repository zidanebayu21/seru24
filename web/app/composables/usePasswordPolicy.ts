/** Aturan password di browser (server hanya menerima auth_secret turunan, jadi tidak bisa mengecek panjang). */
export const usePasswordPolicy = () => {
  const passwordMin = Number(useRuntimeConfig().public.passwordMinLength)

  /** '' = valid; selain itu pesan untuk pengguna. */
  const validateNewPassword = (password: string, confirm: string) => {
    if (password.length < passwordMin) return `Password minimal ${passwordMin} karakter`
    if (password !== confirm) return 'Konfirmasi password tidak sama'
    return ''
  }

  return { passwordMin, validateNewPassword }
}
