import type { SecretKeyring } from '#shared/crypto'

export interface Me {
  id: string
  username: string
  display_name: string
  has_keys: boolean
  key_version: number | null
}

export type AccountStatus = 'unknown' | 'setup' | 'unlock' | 'ready'

export const account = reactive<{ me: Me | null; status: AccountStatus }>({ me: null, status: 'unknown' })

let keyring: SecretKeyring | null = null

export const getKeyring = () => keyring

export const setKeyring = async (ring: SecretKeyring) => {
  keyring = ring
  if (account.me) await saveKeyring(account.me.id, ring)
  account.status = 'ready'
}

const deviceName = () => {
  const ua = navigator.userAgent
  const browser = [['Edg/', 'Edge'], ['Chrome/', 'Chrome'], ['Firefox/', 'Firefox'], ['Safari/', 'Safari']]
    .find(([marker]) => ua.includes(marker!))?.[1] ?? 'Browser'
  const os = [['Windows', 'Windows'], ['Android', 'Android'], ['iPhone', 'iOS'], ['Mac OS', 'macOS'], ['Linux', 'Linux']]
    .find(([marker]) => ua.includes(marker!))?.[1]
  return os ? `${browser} di ${os}` : browser
}

/** Daftarkan perangkat, ambil profil, lalu tentukan langkah berikutnya (buat kunci / buka kunci / siap). */
export const bootstrapAccount = async (afterLogin = false): Promise<AccountStatus> => {
  await rpc('seru24_register_device', { p_platform: 'web', p_name: deviceName(), p_after_login: afterLogin })
  const me = await rpc<Me>('seru24_me')
  account.me = me
  if (me.has_keys) {
    keyring = await loadKeyring(me.id)
    account.status = keyring ? 'ready' : 'unlock'
  } else {
    account.status = 'setup'
  }
  return account.status
}

const resetAccount = () => {
  for (const key of Object.values(keyring ?? {})) key.fill(0)
  keyring = null
  account.me = null
  account.status = 'unknown'
  resetE2ee()
}

/** Logout membersihkan kunci lokal di perangkat (OWASP ASVS V8.2.3) dan mencabut sesi di server. */
export const signOut = async () => {
  const userId = account.me?.id
  closeInbox()
  if (userId) await deleteKeyring(userId).catch(() => undefined)
  resetAccount()
  await logoutSession()
}
