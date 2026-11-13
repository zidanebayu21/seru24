export default defineLoggedHandler(async (event) => {
  assertSameOrigin(event)
  const body = await readBody(event)
  const email = parseEmail(body?.email)
  const password = parsePassword(event, body?.password)
  const username = parseUsername(body?.username)
  const displayName = parseDisplayName(body?.display_name)

  const { data, error } = await authClient(event).auth.signUp({
    email,
    password,
    options: {
      data: { username, display_name: displayName },
      emailRedirectTo: `${getRequestURL(event).origin}/login?verified=1`,
    },
  })
  if (error) {
    // alasan asli (mis. username bentrok, email gagal dikirim) hanya masuk log, tidak ke client
    throw createError({ statusCode: 400, statusMessage: 'Pendaftaran gagal. Periksa data atau coba username lain.', cause: error })
  }
  if (data.user) {
    await logAuthSuccess(event, 'register_success', data.user.id, `Pendaftaran berhasil (@${username})`)
  }
  if (data.session) {
    return { status: 'active', ...issueSession(event, data.session) }
  }
  return { status: 'verify_email' }
}, { rejectedEvent: 'register_rejected', channel: 'auth' })
