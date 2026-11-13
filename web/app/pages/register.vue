<script setup lang="ts">
const form = reactive({ email: '', username: '', display_name: '', password: '', confirm: '' })
const usernameState = ref<'idle' | 'checking' | 'available' | 'taken'>('idle')
const error = ref('')
const done = ref(false)
const busy = ref(false)

const USERNAME_PATTERN = /^[a-z0-9_]{3,30}$/

const checkUsername = async () => {
  form.username = form.username.trim().toLowerCase()
  if (!USERNAME_PATTERN.test(form.username)) {
    usernameState.value = 'idle'
    return
  }
  usernameState.value = 'checking'
  try {
    const available = await rpc<boolean>('seru24_username_available', { p_username: form.username })
    usernameState.value = available ? 'available' : 'taken'
  } catch {
    usernameState.value = 'idle'
  }
}

const validate = () => {
  if (!USERNAME_PATTERN.test(form.username)) return 'Username 3-30 karakter: huruf kecil, angka, atau _'
  if (usernameState.value === 'taken') return 'Username sudah dipakai'
  if (form.password.length < 12) return 'Password minimal 12 karakter'
  if (form.password !== form.confirm) return 'Konfirmasi password tidak sama'
  return ''
}

const submit = async () => {
  error.value = validate()
  if (error.value) return
  busy.value = true
  try {
    const status = await registerAccount({
      email: form.email,
      password: form.password,
      username: form.username,
      display_name: form.display_name,
    })
    if (status === 'active') {
      await bootstrapAccount(true)
      await navigateTo('/')
    } else {
      done.value = true
    }
  } catch (e) {
    error.value = errorMessage(e, 'Pendaftaran gagal. Coba lagi.')
  } finally {
    form.password = ''
    form.confirm = ''
    busy.value = false
  }
}
</script>

<template>
  <AuthCard title="Daftar" subtitle="Hanya pengguna terdaftar yang bisa saling mengirim pesan">
    <p v-if="done" class="notice">
      Tautan verifikasi sudah dikirim ke email Anda. Buka tautan itu, lalu masuk.
    </p>
    <form v-else class="stack" @submit.prevent="submit">
      <label>Email
        <input v-model="form.email" type="email" autocomplete="email" required maxlength="254">
      </label>
      <label>Username
        <input v-model="form.username" autocomplete="username" required maxlength="30" @blur="checkUsername">
        <span v-if="usernameState === 'available'" class="muted">Username tersedia</span>
        <span v-else-if="usernameState === 'taken'" class="error">Username sudah dipakai</span>
      </label>
      <label>Nama tampil
        <input v-model="form.display_name" autocomplete="name" maxlength="50">
      </label>
      <label>Password (minimal 12 karakter)
        <input v-model="form.password" type="password" autocomplete="new-password" required minlength="12" maxlength="128">
      </label>
      <label>Ulangi password
        <input v-model="form.confirm" type="password" autocomplete="new-password" required maxlength="128">
      </label>
      <p v-if="error" class="error" role="alert">{{ error }}</p>
      <button class="primary" type="submit" :disabled="busy">{{ busy ? 'Memproses…' : 'Daftar' }}</button>
    </form>
    <p class="muted">Sudah punya akun? <NuxtLink to="/login">Masuk</NuxtLink></p>
  </AuthCard>
</template>
