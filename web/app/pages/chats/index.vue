<script setup lang="ts">
const conversations = ref<Conversation[]>([])
const query = ref('')
const found = ref<FoundUser | null>(null)
const searched = ref(false)
const error = ref('')
const busy = ref(false)

const load = async () => {
  try {
    conversations.value = await listConversations()
  } catch {
    error.value = 'Gagal memuat percakapan'
  }
}

let reloadTimer: ReturnType<typeof setTimeout> | undefined
const stopInbox = onInbox((event) => {
  if (event !== 'message_new') return
  clearTimeout(reloadTimer)
  reloadTimer = setTimeout(load, 300)
})
onBeforeUnmount(() => {
  stopInbox()
  clearTimeout(reloadTimer)
})

const search = async () => {
  error.value = ''
  found.value = null
  searched.value = false
  const username = query.value.trim().toLowerCase().replace(/^@/, '')
  if (!username) return
  busy.value = true
  try {
    const rows = await rpc<FoundUser[]>('seru24_search_user', { p_username: username })
    found.value = rows[0] ?? null
    searched.value = true
  } catch {
    error.value = 'Pencarian gagal'
  } finally {
    busy.value = false
  }
}

const startChat = async (user: FoundUser) => {
  busy.value = true
  try {
    const result = await rpc<{ ok: boolean; conversation_id?: string }>('seru24_start_direct_chat', { p_target: user.id })
    if (result.ok && result.conversation_id) {
      await navigateTo(`/chats/${result.conversation_id}`)
    } else {
      error.value = 'Tidak dapat memulai percakapan dengan pengguna ini'
    }
  } catch {
    error.value = 'Tidak dapat memulai percakapan'
  } finally {
    busy.value = false
  }
}

onMounted(load)
</script>

<template>
  <main class="page">
    <header class="top row">
      <strong class="brand">seru24</strong>
      <AccountMenu />
    </header>

    <form class="row search" @submit.prevent="search">
      <input v-model="query" placeholder="Cari username persis, mis. zidane_21" maxlength="31" autocomplete="off">
      <button class="primary" type="submit" :disabled="busy">Cari</button>
    </form>
    <div v-if="found" class="found row">
      <div>
        <strong>{{ found.display_name || `@${found.username}` }}</strong>
        <p class="muted">@{{ found.username }}</p>
      </div>
      <button class="primary" type="button" :disabled="busy" @click="startChat(found)">Chat</button>
    </div>
    <p v-else-if="searched" class="muted">Pengguna tidak ditemukan.</p>
    <p v-if="error" class="error" role="alert">{{ error }}</p>

    <ul class="list">
      <li v-for="c in conversations" :key="c.id">
        <NuxtLink :to="`/chats/${c.id}`" class="item row">
          <div class="who">
            <strong>{{ peerLabel(c) }}</strong>
            <p class="muted">
              <span v-if="isIncomingRequest(c)">Permintaan chat baru</span>
              <span v-else-if="c.status === 'pending'">Menunggu diterima</span>
              <span v-else>@{{ c.peer_username }}</span>
            </p>
          </div>
          <div class="meta">
            <span class="muted">{{ formatTime(c.last_message_at) }}</span>
            <span v-if="c.unread > 0" class="badge">{{ c.unread }}</span>
          </div>
        </NuxtLink>
      </li>
    </ul>
    <p v-if="!conversations.length" class="muted empty">Belum ada percakapan. Cari teman dengan username-nya.</p>
  </main>
</template>

<style scoped>
.page { max-width: 640px; margin: 0 auto; padding: 16px; display: grid; gap: 12px; }
.top { justify-content: space-between; }
.brand { color: var(--accent); font-size: 18px; }
.search input { flex: 1; }
.found, .item {
  justify-content: space-between;
  padding: 12px 14px;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius);
}
.found p, .item p { margin: 0; }
.list { list-style: none; margin: 0; padding: 0; display: grid; gap: 8px; }
.item { color: inherit; text-decoration: none; }
.item:hover { border-color: var(--accent); }
.who { min-width: 0; }
.who strong { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.meta { display: grid; justify-items: end; gap: 4px; }
.empty { text-align: center; padding: 24px 0; }
</style>
