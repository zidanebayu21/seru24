const PUBLIC_PAGES = new Set(['/login', '/register'])
const KEY_PAGES: Partial<Record<AccountStatus, string>> = { setup: '/setup-keys', unlock: '/unlock' }
const NOT_FOR_READY = new Set(['/', '/login', '/register', '/setup-keys', '/unlock'])

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

  const required = KEY_PAGES[account.status]
  if (required) {
    return to.path === required ? undefined : navigateTo(required)
  }
  if (NOT_FOR_READY.has(to.path)) {
    return navigateTo('/chats')
  }
})
