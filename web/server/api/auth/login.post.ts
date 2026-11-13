const invalidCredentials = (cause?: unknown) =>
  // Pesan generik: tidak membedakan akun tidak ada dan password salah (OWASP ASVS V2.2)
  createError({ statusCode: 401, statusMessage: 'Email/username atau password salah', cause })

export default defineLoggedHandler(async (event) => {
  assertSameOrigin(event)
  const body = await readBody(event)
  const email = await resolveLoginEmail(event, body?.identifier ?? body?.email)
  const password = typeof body?.password === 'string' ? body.password.slice(0, 128) : ''
  if (!email) throw invalidCredentials(new Error('username tidak ditemukan'))

  const { data, error } = await authClient(event).auth.signInWithPassword({ email, password })
  if (error?.code === 'email_not_confirmed') {
    throw createError({ statusCode: 403, statusMessage: 'Email belum diverifikasi', cause: error })
  }
  if (error || !data.session) throw invalidCredentials(error ?? undefined)

  await logAuthSuccess(event, 'login_success', data.session.user.id, 'Login berhasil')
  return issueSession(event, data.session)
}, { rejectedEvent: 'login_failed', channel: 'auth' })
