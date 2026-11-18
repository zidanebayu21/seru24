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
const perChat = ref<LocalConversationUsage[]>([])

const formatBytes = (bytes: number | null) => {
  if (bytes === null) return 'tidak diketahui'
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`
}

const refreshStats = async () => {
  const myId = account.me?.id ?? ''
  if (!myId) return
  ;[stats.value, perChat.value] = await Promise.all([getLocalChatStorageStats(myId), getLocalConversationUsage(myId)])
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

const runStorageAction = async (action: () => Promise<void>, notice: string, failure: string) => {
  storageBusy.value = true
  storageNotice.value = ''
  storageError.value = ''
  confirmReset.value = false
  try {
    await action()
    await refreshStats()
    storageNotice.value = notice
  } catch {
    storageError.value = failure
  } finally {
    storageBusy.value = false
  }
}

const importInput = ref<HTMLInputElement | null>(null)

const exportChats = () =>
  runStorageAction(
    () => downloadLocalBackup(account.me?.id ?? ''),
    'Cadangan diunduh. Simpan file ini baik-baik: hanya akun ini yang bisa membukanya.',
    'Gagal membuat file cadangan.',
  )

const importChats = async (event: Event) => {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  input.value = ''
  if (!file) return
  let message = ''
  await runStorageAction(
    async () => {
      const result = await importLocalBackupFile(account.me?.id ?? '', file)
      message = `${result.conversations} percakapan dan ${result.messages} pesan digabungkan ke browser ini.`
    },
    '',
    'Gagal mengimpor: pastikan file cadangan seru24 milik akun ini.',
  )
  if (message) storageNotice.value = message
}

const clearChats = () =>
  runStorageAction(
    () => clearAllLocalChats(account.me?.id),
    'Semua riwayat chat lokal di browser ini telah dibersihkan (kunci enkripsi tetap aman).',
    'Gagal membersihkan cache chat lokal.',
  )

const clearOneChat = (item: LocalConversationUsage) =>
  runStorageAction(
    () => clearLocalConversation(account.me?.id ?? '', item.conversationId, item.maxSeq),
    `Riwayat chat ${item.label || 'ini'} di browser ini telah dihapus.`,
    'Gagal menghapus riwayat chat lokal.',
  )

const resetBrowserData = async () => {
  if (!confirmReset.value) {
    confirmReset.value = true
    return
  }
  await runStorageAction(
    () => resetFullLocalStorage({ includeKeyring: false }),
    'Database chat lokal di browser telah dihapus dan direset penuh.',
    'Gagal mereset penyimpanan browser.',
  )
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
      <ul v-if="perChat.length > 0" class="per-chat">
        <li v-for="item in perChat" :key="item.conversationId" class="row">
          <span class="grow">
            <strong>{{ item.label || 'Percakapan' }}</strong>
            <span class="muted"> · {{ item.messages }} pesan · {{ formatBytes(item.bytes) }}</span>
          </span>
          <button type="button" class="link" :disabled="storageBusy" @click="clearOneChat(item)">Hapus</button>
        </li>
      </ul>
      <p v-else class="muted">Belum ada pesan yang tersimpan di browser ini.</p>
      <p v-if="storageNotice" class="notice">{{ storageNotice }}</p>
      <p v-if="storageError" class="error" role="alert">{{ storageError }}</p>
      <div class="stack actions">
        <button type="button" :disabled="storageBusy" @click="exportChats">
          Ekspor riwayat ke file (.txt)
        </button>
        <button type="button" :disabled="storageBusy" @click="importInput?.click()">
          Impor riwayat dari file
        </button>
        <input ref="importInput" type="file" accept=".txt,text/plain" hidden @change="importChats">
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
.per-chat { list-style: none; margin: 0; padding: 0; display: grid; gap: 6px; }
.per-chat li { justify-content: space-between; gap: 8px; }
.grow { flex: 1; min-width: 0; overflow-wrap: anywhere; }
</style>
