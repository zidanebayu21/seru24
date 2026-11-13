/**
 * Reset password dari tautan email (pengguna lupa password). Kunci chat diganti dengan pasangan baru;
 * pesan lama terenkripsi kunci lama sehingga tidak bisa dibaca lagi. Semua sesi diputus.
 * Hanya token hasil tautan pemulihan (amr "recovery") yang diterima, bukan sesi login biasa (OWASP ASVS V2.5).
 */
export default defineSecureHandler(async (event, payload) => {
  const token = String(payload.access_token ?? '')
  const user = await userFromToken(event, token)
  const methods = tokenAuthMethods(token)
  if (!methods.includes('recovery')) {
    throw createError({
      statusCode: 403,
      statusMessage: 'Tautan reset tidak valid. Minta tautan baru.',
      cause: new Error(`amr bukan recovery: ${methods.join(',') || '-'}`),
    })
  }

  const newSecret = parseAuthSecret(payload.new_auth_secret)
  const newSalt = parseAuthSalt(payload.new_auth_salt)
  const publicKey = parsePublicKey(payload.public_key)
  const version = Number(payload.key_version)
  if (!Number.isInteger(version) || version < 1 || version > 32_767) {
    throw createError({ statusCode: 400, statusMessage: 'Data tidak valid' })
  }
  const backup = parseBackup(payload, newSalt)

  const admin = requireServiceClient(event)
  const updated = await admin.auth.admin.updateUserById(user.id, { password: newSecret })
  if (updated.error) throw new Error(`Gagal memperbarui password: ${updated.error.message}`)

  const saved = await admin.rpc('seru24_reset_keys', {
    p_user: user.id,
    p_version: version,
    p_salt: newSalt,
    p_public_key: publicKey,
    p_encrypted_keys: backup.encrypted_keys,
    p_nonce: backup.nonce,
    p_kdf_params: backup.kdf_params,
  })
  if (saved.error) {
    // tidak ada password lama untuk dikembalikan; pengguna cukup meminta tautan reset baru
    throw new Error(`Gagal memasang kunci baru: ${saved.error.message}`)
  }

  await admin.auth.admin.signOut(token, 'global').catch(() => undefined)
  await logAuthSuccess(event, 'password_reset', user.id, `Password direset; kunci chat diganti ke versi ${version}`)
  return { ok: true }
}, { rejectedEvent: 'password_reset_rejected', channel: 'auth' })
