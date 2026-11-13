/**
 * Ganti password (pengguna ingat password lama). Kunci chat tidak berubah; hanya salt dan backup kunci
 * (dibungkus wrap_key dari password baru) yang diganti, jadi semua pesan lama tetap terbaca.
 * OWASP ASVS V2.1.5/V2.1.6 (wajib password lama), V3.3.3 (putus sesi lain setelah ganti password).
 */
export default defineSecureHandler(async (event, payload) => {
  const user = await userFromToken(event, payload.access_token)
  const oldSecret = parseAuthSecret(payload.old_auth_secret)
  const newSecret = parseAuthSecret(payload.new_auth_secret)
  const newSalt = parseAuthSalt(payload.new_auth_salt)
  const backup = parseBackup(payload, newSalt)

  // verifikasi password lama di Supabase; sesi sementara hasil verifikasi langsung dicabut
  const check = await authClient(event).auth.signInWithPassword({ email: user.email, password: oldSecret })
  if (check.error || !check.data.session) {
    throw createError({ statusCode: 401, statusMessage: 'Password lama salah', cause: check.error ?? undefined })
  }
  const admin = requireServiceClient(event)
  await admin.auth.admin.signOut(check.data.session.access_token, 'local').catch(() => undefined)

  const updated = await admin.auth.admin.updateUserById(user.id, { password: newSecret })
  if (updated.error) throw new Error(`Gagal memperbarui password: ${updated.error.message}`)

  const saved = await admin.rpc('seru24_change_auth', {
    p_user: user.id,
    p_salt: newSalt,
    p_encrypted_keys: backup.encrypted_keys,
    p_nonce: backup.nonce,
    p_kdf_params: backup.kdf_params,
  })
  if (saved.error) {
    // kembalikan password lama agar salt lama di database tetap cocok
    await admin.auth.admin.updateUserById(user.id, { password: oldSecret })
    throw new Error(`Gagal menyimpan salt/backup baru: ${saved.error.message}`)
  }

  await admin.auth.admin.signOut(String(payload.access_token), 'others').catch(() => undefined)
  await logAuthSuccess(event, 'password_changed', user.id, 'Password diganti; sesi lain diputus')
  return { ok: true }
}, { rejectedEvent: 'password_change_failed', channel: 'auth' })
