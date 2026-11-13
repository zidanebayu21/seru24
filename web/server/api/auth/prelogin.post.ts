/**
 * Langkah 1 login: kembalikan salt akun agar browser bisa menurunkan auth_secret dari password.
 * Akun tak terdaftar mendapat salt palsu yang tetap, jadi jawaban tidak membedakan akun ada/tidak.
 */
export default defineSecureHandler(async (event, payload) => {
  const identifier = parseIdentifier(payload.identifier)
  const account = await findLoginAccount(event, identifier)
  return { salt: account?.salt ?? fakeSalt(event, identifier) }
}, { rejectedEvent: 'login_failed', channel: 'auth' })
