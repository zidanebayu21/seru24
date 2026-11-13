export default defineEventHandler(async (event) => {
  assertSameOrigin(event)
  const refreshToken = readRefreshToken(event)
  if (!refreshToken) {
    throw createError({ statusCode: 401, statusMessage: 'Sesi berakhir' })
  }

  // Supabase merotasi refresh token pada setiap refresh (OWASP ASVS V3.3)
  const { data, error } = await authClient(event).auth.refreshSession({ refresh_token: refreshToken })
  if (error || !data.session) {
    clearRefreshCookie(event)
    throw createError({ statusCode: 401, statusMessage: 'Sesi berakhir' })
  }
  return issueSession(event, data.session)
})
