<script setup lang="ts">
const route = useRoute()
const email = ref('')
const password = ref('')
const error = ref('')
const busy = ref(false)

const submit = async () => {
  busy.value = true
  error.value = ''
  try {
    await loginWithPassword(email.value, password.value)
    await bootstrapAccount(true)
    await navigateTo('/')
  } catch (e) {
    error.value = errorMessage(e, 'Login gagal. Coba lagi.')
  } finally {
    password.value = ''
    busy.value = false
  }
}
</script>

<template>
  <AuthCard title="Masuk" subtitle="Chat terenkripsi end-to-end">
    <p v-if="route.query.verified === '1'" class="notice">Email terverifikasi. Silakan masuk.</p>
    <form class="stack" @submit.prevent="submit">
      <label>Email
        <input v-model="email" type="email" autocomplete="email" required maxlength="254">
      </label>
      <label>Password
        <input v-model="password" type="password" autocomplete="current-password" required maxlength="128">
      </label>
      <p v-if="error" class="error" role="alert">{{ error }}</p>
      <button class="primary" type="submit" :disabled="busy">{{ busy ? 'Memproses…' : 'Masuk' }}</button>
    </form>
    <p class="muted">Belum punya akun? <NuxtLink to="/register">Daftar</NuxtLink></p>
  </AuthCard>
</template>
