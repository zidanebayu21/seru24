import { createAccountCore, type AccountState } from '#shared/account-core'

export type { AccountStatus, Me } from '#shared/account-core'

export const account = reactive<AccountState>({ me: null, status: 'unknown' })

const deviceName = () => {
  const ua = navigator.userAgent
  const browser = [['Edg/', 'Edge'], ['Chrome/', 'Chrome'], ['Firefox/', 'Firefox'], ['Safari/', 'Safari']]
    .find(([marker]) => ua.includes(marker!))?.[1] ?? 'Browser'
  const os = [['Windows', 'Windows'], ['Android', 'Android'], ['iPhone', 'iOS'], ['Mac OS', 'macOS'], ['Linux', 'Linux']]
    .find(([marker]) => ua.includes(marker!))?.[1]
  return os ? `${browser} di ${os}` : browser
}

// Logika akun bersama web dan mobile ada di shared/account-core.ts.
const core = createAccountCore(
  {
    rpc,
    keyStore: { load: loadKeyring, save: saveKeyring, remove: deleteKeyring },
    platform: 'web',
    deviceName,
  },
  account,
)

export const getKeyring = core.getKeyring
export const setPendingKeyMaterial = core.setPendingKeyMaterial
export const bootstrapAccount = core.bootstrapAccount

/** Logout membersihkan kunci lokal di perangkat (OWASP ASVS V8.2.3) dan mencabut sesi di server. */
export const signOut = async () => {
  closeInbox()
  await core.resetAccount()
  resetE2ee()
  await logoutSession()
}
