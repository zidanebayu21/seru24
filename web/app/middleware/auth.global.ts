const PUBLIC_PAGES = new Set(['/login', '/register', '/lupa-password'])
// halaman tautan email: dibuka apa adanya, sesi yang sedang aktif tidak memengaruhi
const OPEN_PAGES = new Set(['/reset-password'])

export default defineNuxtRouteMiddleware(async (to) => {
  if (import.meta.server || OPEN_PAGES.has(to.path)) return

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
