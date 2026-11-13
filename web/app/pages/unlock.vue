<script setup lang="ts">
import { openKeyBackup, type KeyBackup } from '#shared/crypto'

const code = ref('')
const error = ref('')
const busy = ref(false)
let backup: KeyBackup | null = null

const submit = async () => {
  const me = account.me
  if (!me) return
  busy.value = true
  error.value = ''
  try {
    backup ??= await rpc<KeyBackup | null>('seru24_get_key_backup')
    if (!backup) {
      error.value = 'Terlalu banyak percobaan atau perangkat tidak dikenali. Coba lagi nanti.'
      return
    }
    let ring
    try {
      ring = await openKeyBackup(backup, code.value, me.id)
    } catch {
      error.value = 'Kode Keamanan Chat salah'
      return
    }
    await setKeyring(ring)
    await rpc('seru24_trust_device')
    await navigateTo('/chats')
  } catch {
    error.value = 'Gagal membuka kunci. Coba lagi.'
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <AuthCard title="Buka kunci chat" :subtitle="`Masuk sebagai @${account.me?.username ?? ''}`">
    <p class="muted">Perangkat ini belum menyimpan kunci Anda. Masukkan Kode Keamanan Chat untuk membuka pesan.</p>
    <form class="stack" @submit.prevent="submit">
      <label>Kode Keamanan Chat
        <input v-model="code" type="password" autocomplete="current-password" required maxlength="128">
      </label>
      <p v-if="error" class="error" role="alert">{{ error }}</p>
      <button class="primary" type="submit" :disabled="busy">{{ busy ? 'Membuka…' : 'Buka' }}</button>
    </form>
    <button type="button" class="danger" @click="signOut().then(() => navigateTo('/login'))">Keluar</button>
  </AuthCard>
</template>
