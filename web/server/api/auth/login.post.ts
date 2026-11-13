export default defineEventHandler(async (event) => {
  assertSameOrigin(event)
  const body = await readBody(event)
  const email = parseEmail(body?.email)
  const password = typeof body?.password === 'string' ? body.password.slice(0, 128) : ''

  const { data, error } = await authClient(event).auth.signInWithPassword({ email, password })
  if (error?.code === 'email_not_confirmed') {
    throw createError({ statusCode: 403, statusMessage: 'Email belum diverifikasi' })
  }
  if (error || !data.session) {
    // Pesan generik: tidak membedakan email tidak terdaftar dan password salah (OWASP ASVS V2.2)
    throw createError({ statusCode: 401, statusMessage: 'Email atau password salah' })
  }
  return issueSession(event, data.session)
})
