<script setup lang="ts">
import { createKeyBackup, generateKeyPair, toBase64 } from '#shared/crypto'

const code = ref('')
const confirm = ref('')
const error = ref('')
const busy = ref(false)

const submit = async () => {
  const me = account.me
  if (!me) return
  if (code.value.length < 12) {
    error.value = 'Kode Keamanan Chat minimal 12 karakter'
    return
  }
  if (code.value !== confirm.value) {
    error.value = 'Kode tidak sama'
    return
  }
  busy.value = true
  error.value = ''
  try {
    const pair = generateKeyPair()
    const ring = { 1: pair.secretKey }
    const backup = await createKeyBackup(ring, code.value, me.id)
    await rpc('seru24_set_initial_keys', {
      p_public_key: toBase64(pair.publicKey),
      p_encrypted_keys: backup.encrypted_keys,
      p_nonce: backup.nonce,
      p_kdf: backup.kdf,
      p_kdf_params: backup.kdf_params,
    })
    me.has_keys = true
    me.key_version = 1
    await setKeyring(ring)
    await navigateTo('/chats')
  } catch {
    error.value = 'Gagal menyiapkan kunci. Muat ulang halaman lalu coba lagi.'
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <AuthCard title="Buat Kode Keamanan Chat" subtitle="Langkah terakhir sebelum mulai chat">
    <div class="notice">
      Kode ini membuka pesan Anda di perangkat lain. <strong>Berbeda dari password</strong> dan tidak
      pernah dikirim ke server. Jika lupa, pesan lama tidak bisa dibuka lagi.
    </div>
    <form class="stack" @submit.prevent="submit">
      <label>Kode Keamanan Chat (minimal 12 karakter)
        <input v-model="code" type="password" autocomplete="new-password" required minlength="12" maxlength="128">
      </label>
      <label>Ulangi kode
        <input v-model="confirm" type="password" autocomplete="new-password" required maxlength="128">
      </label>
      <p v-if="error" class="error" role="alert">{{ error }}</p>
      <button class="primary" type="submit" :disabled="busy">{{ busy ? 'Membuat kunci…' : 'Simpan dan lanjut' }}</button>
    </form>
    <button type="button" class="danger" @click="signOut().then(() => navigateTo('/login'))">Keluar</button>
  </AuthCard>
</template>
