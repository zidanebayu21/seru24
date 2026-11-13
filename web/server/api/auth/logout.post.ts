export default defineSecureHandler(async (event, payload) => {
  const accessToken = typeof payload.access_token === 'string' ? payload.access_token : ''

  // Cabut sesi di server, bukan hanya hapus cookie (OWASP ASVS V3.3.1)
  if (accessToken) {
    await authClient(event).auth.admin.signOut(accessToken, 'local').catch(() => undefined)
  }
  clearRefreshCookie(event)
  return { ok: true }
}, { channel: 'auth' })
