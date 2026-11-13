import { createSessionCore } from '#shared/session-core'

export type { RegisterInput } from '#shared/session-core'

// Logika sesi bersama web dan mobile ada di shared/session-core.ts.
const core = createSessionCore(secureFetch, (wrapKey, salt) => setPendingKeyMaterial(wrapKey, salt))

export const clearLocalSession = core.clearLocalSession
export const refreshSession = core.refreshSession
export const getAccessToken = core.getAccessToken
export const loginWithPassword = core.loginWithPassword
export const registerAccount = core.registerAccount
export const logoutSession = core.logoutSession
