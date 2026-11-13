export default defineEventHandler(async (event) => {
  assertSameOrigin(event)
  const body = await readBody(event)
  const email = parseEmail(body?.email)
  const password = parsePassword(body?.password)
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
    throw createError({ statusCode: 400, statusMessage: 'Pendaftaran gagal. Periksa data atau coba username lain.' })
  }
  if (data.session) {
    return { status: 'active', ...issueSession(event, data.session) }
  }
  return { status: 'verify_email' }
})
