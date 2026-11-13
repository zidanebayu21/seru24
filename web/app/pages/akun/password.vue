<script setup lang="ts">
const { passwordMin, validateNewPassword } = usePasswordPolicy()
const oldPassword = ref('')
const password = ref('')
const confirm = ref('')
const error = ref('')
const done = ref(false)
const busy = ref(false)

const submit = async () => {
  error.value = validateNewPassword(password.value, confirm.value)
  if (!error.value && password.value === oldPassword.value) error.value = 'Password baru harus berbeda'
  if (error.value) return
  busy.value = true
  try {
    await changePassword(oldPassword.value, password.value)
    done.value = true
  } catch (e) {
    error.value = errorMessage(e, 'Ganti password gagal. Coba lagi.')
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <AuthCard title="Ganti password" :subtitle="`@${account.me?.username ?? ''}`">
    <p v-if="done" class="notice">
      Password sudah diganti. Semua pesan tetap terbaca. Perangkat lain perlu masuk ulang dengan password baru.
    </p>
    <form v-else class="stack" @submit.prevent="submit">
      <label>Password lama
        <input v-model="oldPassword" type="password" autocomplete="current-password" required maxlength="128">
      </label>
      <label>Password baru (minimal {{ passwordMin }} karakter)
        <input v-model="password" type="password" autocomplete="new-password" required :minlength="passwordMin" maxlength="128">
      </label>
      <label>Ulangi password baru
        <input v-model="confirm" type="password" autocomplete="new-password" required maxlength="128">
      </label>
      <p v-if="error" class="error" role="alert">{{ error }}</p>
      <button class="primary" type="submit" :disabled="busy">{{ busy ? 'Memproses…' : 'Ganti password' }}</button>
    </form>
    <p class="muted"><NuxtLink to="/chats">Kembali ke chat</NuxtLink></p>
  </AuthCard>
</template>
