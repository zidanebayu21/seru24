const PUBLIC_PAGES = new Set(['/login', '/register'])

export default defineNuxtRouteMiddleware(async (to) => {
  if (import.meta.server) return

  const token = await getAccessToken()
  if (!token) {
    return PUBLIC_PAGES.has(to.path) ? undefined : navigateTo('/login')
  }

  if (account.status === 'unknown') {
    try {
      await bootstrapAccount(false)
    } catch {
      await signOut()
      return navigateTo('/login')
    }
  }

  // Kunci chat tidak ada di perangkat ini dan password tidak lagi di memori: minta login ulang
  if (account.status === 'locked') {
    await signOut()
    return navigateTo('/login?relogin=1')
  }
  if (to.path === '/' || PUBLIC_PAGES.has(to.path)) {
    return navigateTo('/chats')
  }
})
