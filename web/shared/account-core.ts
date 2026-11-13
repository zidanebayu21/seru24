// Siklus akun bersama web dan mobile: daftarkan perangkat, ambil profil, siapkan kunci chat
// (dari penyimpanan lokal, buat baru, atau pulihkan dari backup dengan wrap_key).

import {
  createKeyBackup,
  generateKeyPair,
  openKeyBackup,
  toBase64,
  type KeyBackup,
  type SecretKeyring,
} from './crypto'

export interface Me {
  id: string
  username: string
  display_name: string
  has_keys: boolean
  key_version: number | null
}

/** locked = kunci chat belum ada di perangkat ini dan butuh password lagi (login ulang). */
export type AccountStatus = 'unknown' | 'locked' | 'ready'

export interface AccountState {
  me: Me | null
  status: AccountStatus
}

export type Rpc = <T = unknown>(fn: string, args?: Record<string, unknown>, bearer?: string) => Promise<T>

export interface KeyStore {
  load: (userId: string) => Promise<SecretKeyring | null>
  save: (userId: string, keyring: SecretKeyring) => Promise<void>
  remove: (userId: string) => Promise<unknown>
}

export interface AccountDeps {
  rpc: Rpc
  keyStore: KeyStore
  platform: 'web' | 'android' | 'ios'
  deviceName: () => string
}

interface KeyMaterial {
  wrapKey: Uint8Array
  salt: string
}

/** state disediakan pemanggil (web: reactive Vue) agar perubahan langsung terlihat di UI. */
export const createAccountCore = (deps: AccountDeps, state: AccountState) => {
  let keyring: SecretKeyring | null = null
  // wrap_key dari password yang baru diketik; dipakai sekali saat bootstrap lalu dihapus dari memori
  let pendingMaterial: KeyMaterial | null = null

  const setPendingKeyMaterial = (wrapKey: Uint8Array, salt: string) => {
    pendingMaterial?.wrapKey.fill(0)
    pendingMaterial = { wrapKey, salt }
  }

  const takePendingMaterial = () => {
    const material = pendingMaterial
    pendingMaterial = null
    return material
  }

  /** Akun baru: buat pasangan kunci, kunci privat dibungkus wrap_key lalu dibackup ke server. */
  const createInitialKeys = async (me: Me, material: KeyMaterial): Promise<SecretKeyring> => {
    const pair = generateKeyPair()
    const ring: SecretKeyring = { 1: pair.secretKey }
    const backup = createKeyBackup(ring, material.wrapKey, me.id, material.salt)
    await deps.rpc('seru24_set_initial_keys', {
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
    const backup = await deps.rpc<KeyBackup | null>('seru24_get_key_backup')
    if (!backup) throw new Error('Backup kunci tidak tersedia')
    const ring = openKeyBackup(backup, material.wrapKey, me.id)
    await deps.rpc('seru24_trust_device')
    return ring
  }

  const bootstrapAccount = async (afterLogin = false): Promise<AccountStatus> => {
    await deps.rpc('seru24_register_device', { p_platform: deps.platform, p_name: deps.deviceName(), p_after_login: afterLogin })
    const me = await deps.rpc<Me>('seru24_me')
    state.me = me

    keyring = me.has_keys ? await deps.keyStore.load(me.id) : null
    // kunci lokal versi lama (setelah reset password di perangkat lain) dianggap tidak ada
    if (keyring && !keyring[String(me.key_version)]) keyring = null
    const material = takePendingMaterial()
    try {
      if (!keyring && material) {
        keyring = me.has_keys ? await restoreKeys(me, material) : await createInitialKeys(me, material)
        await deps.keyStore.save(me.id, keyring)
      }
    } finally {
      material?.wrapKey.fill(0)
    }

    state.status = keyring ? 'ready' : 'locked'
    return state.status
  }

  /** Hapus kunci dari memori dan penyimpanan lokal perangkat (OWASP ASVS V8.2.3). */
  const resetAccount = async () => {
    const userId = state.me?.id
    for (const key of Object.values(keyring ?? {})) key.fill(0)
    keyring = null
    takePendingMaterial()?.wrapKey.fill(0)
    state.me = null
    state.status = 'unknown'
    if (userId) await deps.keyStore.remove(userId).catch(() => undefined)
  }

  return { getKeyring: () => keyring, setPendingKeyMaterial, bootstrapAccount, resetAccount }
}
