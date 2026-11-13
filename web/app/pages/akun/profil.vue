<script setup lang="ts">
const displayName = ref(account.me?.display_name ?? '')
const error = ref('')
const saved = ref(false)
const busy = ref(false)

const submit = async () => {
  busy.value = true
  error.value = ''
  saved.value = false
  try {
    const result = await rpc<{ display_name: string }>('seru24_update_profile', { p_display_name: displayName.value })
    if (account.me) account.me.display_name = result.display_name
    saved.value = true
  } catch {
    error.value = 'Gagal menyimpan profil. Coba lagi.'
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <AuthCard title="Edit profil" :subtitle="`@${account.me?.username ?? ''}`">
    <form class="stack" @submit.prevent="submit">
      <label>Username
        <input :value="account.me?.username" disabled>
        <span class="muted">Username tidak bisa diubah.</span>
      </label>
      <label>Nama tampil
        <input v-model="displayName" autocomplete="name" maxlength="50">
      </label>
      <p v-if="saved" class="notice">Profil tersimpan.</p>
      <p v-if="error" class="error" role="alert">{{ error }}</p>
      <button class="primary" type="submit" :disabled="busy">{{ busy ? 'Menyimpan…' : 'Simpan' }}</button>
    </form>
    <p class="muted"><NuxtLink to="/chats">Kembali ke chat</NuxtLink></p>
  </AuthCard>
</template>
