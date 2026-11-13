<script setup lang="ts">
const route = useRoute()
const identifier = ref('')
const password = ref('')
const error = ref('')
const busy = ref(false)

const submit = async () => {
  busy.value = true
  error.value = ''
  try {
    await loginWithPassword(identifier.value, password.value)
  } catch (e) {
    error.value = errorMessage(e, 'Login gagal. Coba lagi.')
    busy.value = false
    return
  }
  try {
    if ((await bootstrapAccount(true)) !== 'ready') throw new Error('kunci chat terkunci')
    await navigateTo('/')
  } catch {
    await signOut()
    error.value = 'Login berhasil, tetapi kunci chat tidak bisa dibuka. Coba lagi.'
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <AuthCard title="Masuk" subtitle="Chat terenkripsi end-to-end">
    <p v-if="route.query.verified === '1'" class="notice">Email terverifikasi. Silakan masuk.</p>
    <p v-else-if="route.query.relogin === '1'" class="notice">Masuk lagi untuk membuka pesan di perangkat ini.</p>
    <p v-else-if="route.query.reset === '1'" class="notice">Password sudah direset. Masuk dengan password baru.</p>
    <form class="stack" @submit.prevent="submit">
      <label>Email atau username
        <input
          v-model="identifier"
          autocomplete="username"
          autocapitalize="none"
          spellcheck="false"
          required
          maxlength="254"
        >
      </label>
      <label>Password
        <input v-model="password" type="password" autocomplete="current-password" required maxlength="128">
      </label>
      <p v-if="error" class="error" role="alert">{{ error }}</p>
      <button class="primary" type="submit" :disabled="busy">{{ busy ? 'Memproses…' : 'Masuk' }}</button>
    </form>
    <p class="muted">
      <NuxtLink to="/lupa-password">Lupa password?</NuxtLink> · Belum punya akun? <NuxtLink to="/register">Daftar</NuxtLink>
    </p>
  </AuthCard>
</template>
