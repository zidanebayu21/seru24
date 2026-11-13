/**
 * Minta tautan reset password ke email. Jawaban selalu sama, ada atau tidaknya akun,
 * agar tidak bisa dipakai menebak akun (OWASP ASVS V2.5.1). Kegagalan kirim hanya masuk log.
 */
export default defineSecureHandler(async (event, payload) => {
  const identifier = parseIdentifier(payload.identifier)
  const account = await findLoginAccount(event, identifier)
  if (account) {
    const { error } = await authClient(event).auth.resetPasswordForEmail(account.email, {
      redirectTo: `${getRequestURL(event).origin}/reset-password`,
    })
    if (error) {
      await logAuthEvent(event, 'warning', 'password_reset_email_failed', `Email reset gagal dikirim: ${error.message}`, 502)
    } else {
      await logAuthEvent(event, 'info', 'password_reset_requested', 'Tautan reset password dikirim', 200)
    }
  }
  return { ok: true }
}, { rejectedEvent: 'password_reset_rejected', channel: 'auth' })
