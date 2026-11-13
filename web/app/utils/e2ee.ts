import { createE2ee } from '#shared/e2ee-core'

export type { ChatMessage, PeerKeyStatus } from '#shared/e2ee-core'

// Logika E2EE bersama web dan mobile ada di shared/e2ee-core.ts; di web TOFU disimpan di localStorage.
const core = createE2ee({
  rpc,
  getKeyring: () => getKeyring(),
  getMe: () => account.me,
  tofu: {
    get: async (key) => localStorage.getItem(key),
    set: async (key, value) => localStorage.setItem(key, value),
  },
})

export const resetE2ee = core.resetE2ee
export const encryptText = core.encryptText
export const decryptText = core.decryptText
export const checkPeerKey = core.checkPeerKey
export const acceptPeerKey = core.acceptPeerKey
