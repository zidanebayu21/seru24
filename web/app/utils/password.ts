import {
  createKeyBackup,
  derivePasswordSecrets,
  fromBase64Url,
  generateKeyPair,
  newAuthSalt,
  toBase64,
} from '#shared/crypto'

// Ganti dan reset password (doc/keamanan-password-transport.md bagian "Ganti dan reset password").

const wipe = (...keys: Uint8Array[]) => keys.forEach((key) => key.fill(0))

/** Ingat password lama: kunci chat tetap, backup dibungkus ulang dengan password baru. */
export const changePassword = async (oldPassword: string, newPassword: string) => {
  const me = account.me
  const ring = getKeyring()
  const token = await getAccessToken()
  if (!me || !ring || !token) throw new Error('Sesi berakhir. Masuk lagi.')

  const { salt } = await secureFetch<{ salt: string }>('/api/auth/prelogin', { identifier: me.username })
  const oldSecrets = await derivePasswordSecrets(oldPassword, salt)
  const newSalt = newAuthSalt()
  const newSecrets = await derivePasswordSecrets(newPassword, newSalt)
  try {
    const backup = createKeyBackup(ring, newSecrets.wrapKey, me.id, newSalt)
    await secureFetch('/api/auth/change-password', {
      access_token: token,
      old_auth_secret: oldSecrets.authSecret,
      new_auth_secret: newSecrets.authSecret,
      new_auth_salt: newSalt,
      encrypted_keys: backup.encrypted_keys,
      nonce: backup.nonce,
    })
  } finally {
    wipe(oldSecrets.wrapKey, newSecrets.wrapKey)
  }
}

/** Langkah 1 lupa password: kirim tautan reset ke email (jawaban selalu sama). */
export const requestPasswordReset = (identifier: string) =>
  secureFetch('/api/auth/forgot-password', { identifier })

/** Token pemulihan dari fragment URL tautan email (#access_token=...&type=recovery). */
export const readRecoveryToken = (hash: string): string | null => {
  const params = new URLSearchParams(hash.replace(/^#/, ''))
  return params.get('type') === 'recovery' ? params.get('access_token') : null
}

const tokenSubject = (token: string): string => {
  const claims = JSON.parse(new TextDecoder().decode(fromBase64Url(token.split('.')[1] ?? ''))) as { sub?: string }
  if (!claims.sub) throw new Error('Tautan reset tidak valid')
  return claims.sub
}

/**
 * Langkah 2 lupa password: buat kunci chat baru (versi berikutnya) yang dibungkus password baru.
 * Pesan lama tidak bisa dibaca lagi karena terenkripsi kunci lama.
 */
export const completePasswordReset = async (recoveryToken: string, newPassword: string) => {
  const userId = tokenSubject(recoveryToken)
  const keys = await rpc<Array<{ key_version: number }>>('seru24_get_public_keys', { p_user: userId }, recoveryToken)
  const version = Math.max(0, ...keys.map((k) => k.key_version)) + 1

  const salt = newAuthSalt()
  const secrets = await derivePasswordSecrets(newPassword, salt)
  const pair = generateKeyPair()
  try {
    const backup = createKeyBackup({ [version]: pair.secretKey }, secrets.wrapKey, userId, salt)
    await secureFetch('/api/auth/reset-password', {
      access_token: recoveryToken,
      new_auth_secret: secrets.authSecret,
      new_auth_salt: salt,
      key_version: version,
      public_key: toBase64(pair.publicKey),
      encrypted_keys: backup.encrypted_keys,
      nonce: backup.nonce,
    })
  } finally {
    wipe(secrets.wrapKey, pair.secretKey)
  }
}
