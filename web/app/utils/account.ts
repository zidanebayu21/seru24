import {
  createKeyBackup,
  generateKeyPair,
  openKeyBackup,
  toBase64,
  type KeyBackup,
  type SecretKeyring,
} from '#shared/crypto'

export interface Me {
  id: string
  username: string
  display_name: string
  has_keys: boolean
  key_version: number | null
}

/** locked = kunci chat belum ada di perangkat ini dan butuh password lagi (login ulang). */
export type AccountStatus = 'unknown' | 'locked' | 'ready'

interface KeyMaterial {
  wrapKey: Uint8Array
  salt: string
}

export const account = reactive<{ me: Me | null; status: AccountStatus }>({ me: null, status: 'unknown' })

let keyring: SecretKeyring | null = null
// wrap_key dari password yang baru diketik; dipakai sekali saat bootstrap lalu dihapus dari memori
let pendingMaterial: KeyMaterial | null = null

export const getKeyring = () => keyring

export const setPendingKeyMaterial = (wrapKey: Uint8Array, salt: string) => {
  pendingMaterial?.wrapKey.fill(0)
  pendingMaterial = { wrapKey, salt }
}

const takePendingMaterial = () => {
  const material = pendingMaterial
  pendingMaterial = null
  return material
}

const deviceName = () => {
  const ua = navigator.userAgent
  const browser = [['Edg/', 'Edge'], ['Chrome/', 'Chrome'], ['Firefox/', 'Firefox'], ['Safari/', 'Safari']]
    .find(([marker]) => ua.includes(marker!))?.[1] ?? 'Browser'
  const os = [['Windows', 'Windows'], ['Android', 'Android'], ['iPhone', 'iOS'], ['Mac OS', 'macOS'], ['Linux', 'Linux']]
    .find(([marker]) => ua.includes(marker!))?.[1]
  return os ? `${browser} di ${os}` : browser
}

/** Akun baru: buat pasangan kunci, kunci privat dibungkus wrap_key lalu dibackup ke server. */
const createInitialKeys = async (me: Me, material: KeyMaterial): Promise<SecretKeyring> => {
  const pair = generateKeyPair()
  const ring: SecretKeyring = { 1: pair.secretKey }
  const backup = createKeyBackup(ring, material.wrapKey, me.id, material.salt)
  await rpc('seru24_set_initial_keys', {
    p_public_key: toBase64(pair.publicKey),
    p_encrypted_keys: backup.encrypted_keys,
    p_nonce: backup.nonce,
    p_kdf: backup.kdf,
    p_kdf_params: backup.kdf_params,
  })
  me.has_keys = true
  me.key_version = 1
  return ring
}

/** Perangkat baru / setelah logout: buka backup kunci dengan wrap_key dari password. */
const restoreKeys = async (me: Me, material: KeyMaterial): Promise<SecretKeyring> => {
  const backup = await rpc<KeyBackup | null>('seru24_get_key_backup')
  if (!backup) throw new Error('Backup kunci tidak tersedia')
  const ring = openKeyBackup(backup, material.wrapKey, me.id)
  await rpc('seru24_trust_device')
  return ring
}

/** Daftarkan perangkat, ambil profil, lalu siapkan kunci chat (lokal, buat baru, atau pulihkan). */
export const bootstrapAccount = async (afterLogin = false): Promise<AccountStatus> => {
  await rpc('seru24_register_device', { p_platform: 'web', p_name: deviceName(), p_after_login: afterLogin })
  const me = await rpc<Me>('seru24_me')
  account.me = me

  keyring = me.has_keys ? await loadKeyring(me.id) : null
  const material = takePendingMaterial()
  try {
    if (!keyring && material) {
      keyring = me.has_keys ? await restoreKeys(me, material) : await createInitialKeys(me, material)
      await saveKeyring(me.id, keyring)
    }
  } finally {
    material?.wrapKey.fill(0)
  }

  account.status = keyring ? 'ready' : 'locked'
  return account.status
}

const resetAccount = () => {
  for (const key of Object.values(keyring ?? {})) key.fill(0)
  keyring = null
  takePendingMaterial()?.wrapKey.fill(0)
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
