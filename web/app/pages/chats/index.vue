<script setup lang="ts">
const conversations = ref<Conversation[]>([])
const query = ref('')
const found = ref<FoundUser | null>(null)
const searched = ref(false)
const error = ref('')
const busy = ref(false)
const hasMore = ref(false)
const loadingMore = ref(false)

const saveCache = async (myId: string | undefined, fresh: Conversation[]) => {
  if (!myId) return
  const cached = hasMore.value ? await loadLocalConversations(myId).catch(() => []) : []
  saveLocalConversations(myId, cacheableConversations(fresh, cached, hasMore.value)).catch(() => undefined)
}

const load = async () => {
  const myId = account.me?.id
  if (myId && conversations.value.length === 0) {
    const cached = await loadLocalConversations(myId).catch(() => [])
    if (cached.length > 0) conversations.value = cached
  }
  try {
    // muat ulang sebanyak yang sudah tampil (minimal satu halaman) agar daftar tidak menciut saat ada pesan baru
    const limit = Math.max(CONVERSATION_PAGE_SIZE, conversations.value.length)
    const fresh = await listConversations({ limit })
    conversations.value = fresh
    hasMore.value = fresh.length >= limit
    await saveCache(myId, fresh)
  } catch {
    if (conversations.value.length === 0) error.value = 'Gagal memuat percakapan'
  }
}

const loadMore = async () => {
  if (loadingMore.value || !hasMore.value) return
  loadingMore.value = true
  try {
    const page = await listConversations({ limit: CONVERSATION_PAGE_SIZE, offset: conversations.value.length })
    conversations.value = appendConversations(conversations.value, page)
    hasMore.value = page.length >= CONVERSATION_PAGE_SIZE
    await saveCache(account.me?.id, conversations.value)
  } catch {
    error.value = 'Gagal memuat percakapan berikutnya'
  } finally {
    loadingMore.value = false
  }
}

let reloadTimer: ReturnType<typeof setTimeout> | undefined
const stopInbox = onInbox((event) => {
  if (event !== 'message_new') return
  clearTimeout(reloadTimer)
  reloadTimer = setTimeout(load, 300)
})
// tab terlihat lagi / koneksi kembali: siaran realtime yang terlewat (jumlah belum dibaca, urutan) disusul
const reloadOnReturn = () => {
  if (document.visibilityState === 'visible') void load()
}
onMounted(() => {
  document.addEventListener('visibilitychange', reloadOnReturn)
  window.addEventListener('online', reloadOnReturn)
})
onBeforeUnmount(() => {
  stopInbox()
  clearTimeout(reloadTimer)
  document.removeEventListener('visibilitychange', reloadOnReturn)
  window.removeEventListener('online', reloadOnReturn)
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
      <h1 class="title">Chat</h1>
      <AccountMenu />
    </header>

    <form class="row search" @submit.prevent="search">
      <label for="search-username-input" class="sr-only">Cari username</label>
      <input id="search-username-input" v-model="query" placeholder="Cari username persis, mis. zidane_21" maxlength="31" autocomplete="off">
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

    <ul v-if="conversations.length" class="list">
      <li v-for="c in conversations" :key="c.id">
        <NuxtLink :to="`/chats/${c.id}`" class="item">
          <Avatar :name="peerLabel(c)" :seed="c.peer_username" :size="46" />
          <div class="who">
            <div class="line">
              <strong>{{ peerLabel(c) }}</strong>
              <span class="time" :class="{ fresh: c.unread > 0 }">{{ formatTime(c.last_message_at) }}</span>
            </div>
            <div class="line">
              <p class="sub">
                <template v-if="isIncomingRequest(c)">Permintaan chat baru</template>
                <template v-else-if="c.status === 'pending'">Menunggu diterima</template>
                <template v-else>@{{ c.peer_username }}</template>
              </p>
              <span v-if="c.unread > 0" class="badge">{{ c.unread }}</span>
            </div>
          </div>
        </NuxtLink>
      </li>
    </ul>
    <button v-if="hasMore" class="more" type="button" :disabled="loadingMore" @click="loadMore">
      {{ loadingMore ? 'Memuat…' : 'Muat lebih banyak' }}
    </button>
    <p v-if="!conversations.length" class="muted empty">Belum ada percakapan. Cari teman dengan username-nya.</p>
  </main>
</template>

<style scoped>
.page { max-width: 640px; margin: 0 auto; padding: 20px 16px 32px; display: grid; gap: 14px; }
.top { justify-content: space-between; }
.title { margin: 0; font-size: 28px; line-height: 1.1; letter-spacing: -.03em; }
.more { justify-self: center; }
.search input { flex: 1; border-radius: 999px; padding-left: 18px; }
.search button { border-radius: 999px; }
.found {
  justify-content: space-between;
  padding: 12px 14px;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 14px;
}
.found p { margin: 0; }
.list {
  margin: 0;
  padding: 0;
  list-style: none;
  overflow: hidden;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 16px;
}
.list li + li { border-top: 1px solid var(--border); }
.item {
  display: flex;
  align-items: center;
  gap: 13px;
  padding: 12px 14px;
  color: inherit;
  text-decoration: none;
  transition: background-color .12s;
}
.item:hover { background: color-mix(in srgb, var(--accent) 7%, var(--surface)); }
.item:focus-visible { outline-offset: -2px; }
.who { flex: 1; min-width: 0; display: grid; gap: 2px; }
.line { display: flex; align-items: center; justify-content: space-between; gap: 10px; min-width: 0; }
.line strong { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 600; }
.sub { margin: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--muted); font-size: 13.5px; }
.time { flex: none; color: var(--muted); font-size: 12px; }
.time.fresh { color: var(--accent); font-weight: 600; }
.empty { text-align: center; padding: 40px 0; }
</style>
