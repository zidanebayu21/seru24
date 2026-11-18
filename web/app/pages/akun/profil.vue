<script setup lang="ts">
const displayName = ref(account.me?.display_name ?? '')
const error = ref('')
const saved = ref(false)
const busy = ref(false)

const stats = ref<LocalChatStorageStats>({ conversations: 0, messages: 0, usageBytes: null, quotaBytes: null })
const storageBusy = ref(false)
const storageNotice = ref('')
const storageError = ref('')
const confirmReset = ref(false)

const formatBytes = (bytes: number | null) => {
  if (bytes === null) return 'tidak diketahui'
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`
}

const refreshStats = async () => {
  const myId = account.me?.id ?? ''
  if (!myId) return
  stats.value = await getLocalChatStorageStats(myId)
}

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

const clearChats = async () => {
  storageBusy.value = true
  storageNotice.value = ''
  storageError.value = ''
  confirmReset.value = false
  try {
    await clearAllLocalChats(account.me?.id)
    await refreshStats()
    storageNotice.value = 'Semua riwayat chat lokal di browser ini telah dibersihkan (kunci enkripsi tetap aman).'
  } catch {
    storageError.value = 'Gagal membersihkan cache chat lokal.'
  } finally {
    storageBusy.value = false
  }
}

const resetBrowserData = async () => {
  if (!confirmReset.value) {
    confirmReset.value = true
    return
  }
  storageBusy.value = true
  storageNotice.value = ''
  storageError.value = ''
  confirmReset.value = false
  try {
    await resetFullLocalStorage({ includeKeyring: false })
    await refreshStats()
    storageNotice.value = 'Database chat lokal di browser telah dihapus dan direset penuh.'
  } catch {
    storageError.value = 'Gagal mereset penyimpanan browser.'
  } finally {
    storageBusy.value = false
  }
}

onMounted(() => {
  refreshStats().catch(() => undefined)
})
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

    <hr class="sep">

    <section class="stack storage-box">
      <div>
        <h2 class="subhead">Penyimpanan Chat Lokal (Chrome DB)</h2>
        <p class="muted">
          {{ stats.conversations }} percakapan · {{ stats.messages }} pesan tersimpan di browser
          ({{ formatBytes(stats.usageBytes) }})
        </p>
      </div>
      <p v-if="storageNotice" class="notice">{{ storageNotice }}</p>
      <p v-if="storageError" class="error" role="alert">{{ storageError }}</p>
      <div class="stack actions">
        <button type="button" :disabled="storageBusy" @click="clearChats">
          Bersihkan semua chat lokal
        </button>
        <button type="button" class="danger" :disabled="storageBusy" @click="resetBrowserData">
          {{ confirmReset ? 'Klik lagi untuk konfirmasi reset penuh DB browser' : 'Reset penuh data browser' }}
        </button>
        <button v-if="confirmReset" type="button" :disabled="storageBusy" @click="confirmReset = false">
          Batal
        </button>
      </div>
    </section>

    <p class="muted"><NuxtLink to="/chats">Kembali ke chat</NuxtLink></p>
  </AuthCard>
</template>

<style scoped>
.sep { border: 0; border-top: 1px solid var(--border); margin: 4px 0; }
.subhead { margin: 0 0 4px; font-size: 16px; }
.storage-box p { margin: 0; }
.actions { gap: 8px; }
</style>
