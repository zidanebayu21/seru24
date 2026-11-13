export default defineLoggedHandler(async (event) => {
  assertSameOrigin(event)
  const accessToken = getRequestHeader(event, 'authorization')?.replace(/^Bearer\s+/i, '')

  // Cabut sesi di server, bukan hanya hapus cookie (OWASP ASVS V3.3.1)
  if (accessToken) {
    await authClient(event).auth.admin.signOut(accessToken, 'local').catch(() => undefined)
  }
  clearRefreshCookie(event)
  return { ok: true }
}, { channel: 'auth' })
