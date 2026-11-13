const invalidCredentials = (cause?: unknown) =>
  // Pesan generik: tidak membedakan akun tidak ada dan password salah (OWASP ASVS V2.2)
  createError({ statusCode: 401, statusMessage: 'Email/username atau password salah', cause })

/** Langkah 2 login: auth_secret (turunan password di browser) diteruskan ke Supabase sebagai password. */
export default defineSecureHandler(async (event, payload) => {
  const identifier = parseIdentifier(payload.identifier)
  const authSecret = parseAuthSecret(payload.auth_secret)
  const account = await findLoginAccount(event, identifier)
  if (!account) throw invalidCredentials(new Error('akun tidak ditemukan'))

  const { data, error } = await authClient(event).auth.signInWithPassword({ email: account.email, password: authSecret })
  if (error?.code === 'email_not_confirmed') {
    throw createError({ statusCode: 403, statusMessage: 'Email belum diverifikasi', cause: error })
  }
  if (error || !data.session) throw invalidCredentials(error ?? undefined)

  await logAuthSuccess(event, 'login_success', data.session.user.id, 'Login berhasil')
  return issueSession(event, data.session)
}, { rejectedEvent: 'login_failed', channel: 'auth' })
