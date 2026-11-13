<script setup lang="ts">
const identifier = ref('')
const sent = ref(false)
const error = ref('')
const busy = ref(false)

const submit = async () => {
  busy.value = true
  error.value = ''
  try {
    await requestPasswordReset(identifier.value)
    sent.value = true
  } catch (e) {
    error.value = errorMessage(e, 'Permintaan gagal. Coba lagi.')
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <AuthCard title="Lupa password" subtitle="Tautan reset dikirim ke email akun Anda">
    <p class="notice">
      Reset password membuat kunci enkripsi baru. <strong>Pesan lama tidak dapat dibaca lagi.</strong>
      Jika masih ingat password lama, masuk lalu gunakan Ganti password agar pesan tetap terbaca.
    </p>
    <p v-if="sent" class="notice">
      Jika akun terdaftar, tautan reset sudah dikirim ke emailnya. Periksa kotak masuk dan folder spam.
    </p>
    <form v-else class="stack" @submit.prevent="submit">
      <label>Email atau username
        <input v-model="identifier" autocomplete="username" autocapitalize="none" spellcheck="false" required maxlength="254">
      </label>
      <p v-if="error" class="error" role="alert">{{ error }}</p>
      <button class="primary" type="submit" :disabled="busy">{{ busy ? 'Mengirim…' : 'Kirim tautan reset' }}</button>
    </form>
    <p class="muted"><NuxtLink to="/login">Kembali ke halaman masuk</NuxtLink></p>
  </AuthCard>
</template>
