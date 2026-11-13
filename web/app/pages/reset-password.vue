<script setup lang="ts">
const { passwordMin, validateNewPassword } = usePasswordPolicy()
const password = ref('')
const confirm = ref('')
const error = ref('')
const busy = ref(false)
const token = ref<string | null>(null)

onMounted(() => {
  token.value = readRecoveryToken(window.location.hash)
  // token jangan tertinggal di address bar / riwayat browser
  history.replaceState(null, '', window.location.pathname)
})

const submit = async () => {
  if (!token.value) return
  error.value = validateNewPassword(password.value, confirm.value)
  if (error.value) return
  busy.value = true
  try {
    await completePasswordReset(token.value, password.value)
    await navigateTo('/login?reset=1')
  } catch (e) {
    error.value = errorMessage(e, 'Reset password gagal. Minta tautan baru lalu coba lagi.')
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <AuthCard title="Buat password baru">
    <p v-if="!token" class="error">
      Tautan reset tidak valid atau sudah dipakai. <NuxtLink to="/lupa-password">Minta tautan baru</NuxtLink>.
    </p>
    <template v-else>
      <p class="notice">
        Setelah reset, kunci enkripsi baru dibuat. <strong>Pesan lama tidak dapat dibaca lagi</strong>,
        dan semua perangkat harus masuk ulang.
      </p>
      <form class="stack" @submit.prevent="submit">
        <label>Password baru (minimal {{ passwordMin }} karakter)
          <input v-model="password" type="password" autocomplete="new-password" required :minlength="passwordMin" maxlength="128">
        </label>
        <label>Ulangi password baru
          <input v-model="confirm" type="password" autocomplete="new-password" required maxlength="128">
        </label>
        <p v-if="error" class="error" role="alert">{{ error }}</p>
        <button class="primary" type="submit" :disabled="busy">{{ busy ? 'Memproses…' : 'Reset password' }}</button>
      </form>
    </template>
  </AuthCard>
</template>
