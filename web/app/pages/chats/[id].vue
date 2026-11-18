<script setup lang="ts">
import { MAX_TEXT_LENGTH, randomId } from '#shared/crypto'
import {
  CHAT_PAGE_SIZE,
  CHAT_PREFETCH_OFFSET,
  bubbleStatus,
  compareBubbles,
  markMessageDeleted,
  mergeCachedMessages,
  mergePagedBubbles,
  oldestPersistedSeq,
  replySnippet,
  sliceMessagesPage,
} from '#shared/chat-core'
import { createConversationPresence, type PeerPresence } from '#shared/presence-core'
import { MAX_FILE_BYTES, formatFileSize, safeFileName, type FileMessageBody } from '#shared/file-core'

interface Bubble {
  key: string
  id: string | null
  seq: number
  mine: boolean
  text: string | null
  createdAt: string
  deleted: boolean
  pending: boolean
  failed: string
  file: FileMessageBody | null
  /** Status unggah/unduh dokumen yang sedang berjalan. */
  progress: string
  /** id pesan yang dibalas (kolom reply_to). */
  replyTo: string | null
}

type SendParams = Awaited<ReturnType<typeof encryptText>> & { p_attachment_id?: string; p_reply_to?: string | null }

const REPORT_REASONS = [
  { value: 'spam', label: 'Spam' },
  { value: 'abuse', label: 'Pelecehan' },
  { value: 'scam', label: 'Penipuan' },
  { value: 'other', label: 'Lainnya' },
]

const route = useRoute()
const conversationId = route.params.id as string
const conversation = ref<Conversation | null>(null)
const bubbles = ref<Bubble[]>([])
const allMessages = ref<ChatMessage[]>([])
const deletedIds = ref<Set<string>>(new Set())
const clearedUpToSeq = ref(0)
const serverExhausted = ref(false)
const peerReadSeq = ref(0)
const keyStatus = ref<PeerKeyStatus>({ status: 'missing' })
const draft = ref('')
const error = ref('')
const hasOlder = ref(false)
const loadingOlder = ref(false)
const showSafety = ref(false)
const reportReason = ref('')
const reportDone = ref(false)
const scroller = ref<HTMLElement | null>(null)
const fileInput = ref<HTMLInputElement | null>(null)
const replyingTo = ref<Bubble | null>(null)
const peerPresence = ref<PeerPresence>({ online: false, typing: false })
let presence: ReturnType<typeof createConversationPresence> | null = null

const peerId = () => conversation.value?.peer_id ?? ''

const toBubble = async (m: ChatMessage): Promise<Bubble> => ({
  key: m.client_msg_id,
  id: m.id,
  seq: m.seq,
  mine: m.sender_id === account.me?.id,
  text: await decryptText(m, peerId()),
  createdAt: m.created_at,
  deleted: Boolean(m.deleted_at),
  pending: false,
  failed: '',
  file: await decryptFile(m, peerId()),
  progress: '',
  replyTo: m.reply_to,
})

const percent = (done: number, total: number) => `${Math.round((done / Math.max(total, 1)) * 100)}%`

const localBubble = (text: string, replyTo: string | null = null): Bubble => reactive<Bubble>({
  key: `local-${randomId()}`, id: null, seq: 0, mine: true, text,
  createdAt: new Date().toISOString(), deleted: false, pending: true, failed: '', file: null, progress: '', replyTo,
})

/** Pesan yang dikutip (bila sudah termuat di layar) beserta nama pengirimnya. */
const quoteOf = (b: Bubble) => {
  const target = b.replyTo ? bubbles.value.find((x) => x.id === b.replyTo) : undefined
  const who = !target ? '' : target.mine ? 'Anda' : peerLabel(conversation.value!)
  return { who, snippet: replySnippet(target) }
}

/** Status mengetik/online lawan (channel conv:<id>); bisa dimatikan lewat NUXT_PUBLIC_REALTIME_PRESENCE=false. */
const startPresence = () => {
  const myId = account.me?.id
  if (!myId || !useRuntimeConfig().public.realtimePresence) return
  presence = createConversationPresence(useSupabase(), conversationId, myId, (state) => { peerPresence.value = state })
}
onBeforeUnmount(() => presence?.close())

const scrollToBottom = async () => {
  await nextTick()
  scroller.value?.scrollTo({ top: scroller.value.scrollHeight })
}

const lastSeq = () => bubbles.value.reduce((max, b) => (b.pending ? max : Math.max(max, b.seq)), 0)

const markRead = () => {
  const seq = lastSeq()
  if (seq > 0) rpc('seru24_mark_read', { p_conversation_id: conversationId, p_seq: seq }).catch(() => undefined)
}

const fetchPage = (beforeSeq?: number) =>
  rpc<ChatMessage[]>('seru24_get_messages', {
    p_conversation_id: conversationId,
    p_before_seq: beforeSeq ?? null,
    p_limit: CHAT_PAGE_SIZE,
  })

const load = async () => {
  const myId = account.me?.id ?? ''
  let list: Conversation[] = []
  try {
    list = await listConversations()
    if (myId) saveLocalConversations(myId, list).catch(() => undefined)
  } catch {
    if (myId) list = await loadLocalConversations(myId).catch(() => [])
  }
  conversation.value = list.find((c) => c.id === conversationId) ?? null
  if (!conversation.value) {
    await navigateTo('/chats')
    return
  }
  startPresence()
  // centang dua tetap benar setelah halaman dimuat ulang
  rpc<number>('seru24_peer_read_seq', { p_conversation_id: conversationId })
    .then((seq) => { peerReadSeq.value = Math.max(peerReadSeq.value, Number(seq) || 0) })
    .catch(() => undefined)

  const localState = myId
    ? await loadLocalConversationState(myId, conversationId)
    : { messages: [], deletedIds: new Set<string>(), clearedUpToSeq: 0 }
  deletedIds.value = localState.deletedIds
  clearedUpToSeq.value = localState.clearedUpToSeq
  allMessages.value = localState.messages

  keyStatus.value = await checkPeerKey(peerId())

  if (allMessages.value.length > 0) {
    const initialSlice = sliceMessagesPage(allMessages.value, null, CHAT_PAGE_SIZE)
    bubbles.value = await Promise.all(initialSlice.rows.map(toBubble))
    hasOlder.value = initialSlice.hasOlder
    await scrollToBottom()
  }

  try {
    const rows = await fetchPage()
    serverExhausted.value = rows.length < CHAT_PAGE_SIZE
    const merged = mergeCachedMessages(allMessages.value, rows, deletedIds.value, clearedUpToSeq.value)
    allMessages.value = merged
    if (myId && rows.length > 0) {
      await saveLocalMessages(myId, conversationId, rows).catch(() => undefined)
    }
    const latestSlice = sliceMessagesPage(merged, null, CHAT_PAGE_SIZE)
    hasOlder.value = latestSlice.hasOlder || !serverExhausted.value
    bubbles.value = await Promise.all(latestSlice.rows.map(toBubble))
    await scrollToBottom()
    markRead()
  } catch {
    if (allMessages.value.length === 0) throw new Error('Gagal memuat pesan')
  }
}

const loadOlder = async () => {
  if (!hasOlder.value || loadingOlder.value) return
  const beforeSeq = oldestPersistedSeq(bubbles.value)
  if (beforeSeq === null) {
    hasOlder.value = false
    return
  }
  loadingOlder.value = true
  try {
    const myId = account.me?.id ?? ''
    if (!serverExhausted.value) {
      const rows = await fetchPage(beforeSeq).catch(() => null)
      if (rows) {
        if (rows.length < CHAT_PAGE_SIZE) serverExhausted.value = true
        allMessages.value = mergeCachedMessages(allMessages.value, rows, deletedIds.value, clearedUpToSeq.value)
        if (myId && rows.length > 0) {
          await saveLocalMessages(myId, conversationId, rows).catch(() => undefined)
        }
      }
    }

    const page = sliceMessagesPage(allMessages.value, beforeSeq, CHAT_PAGE_SIZE)
    const older = await Promise.all(page.rows.map(toBubble))
    const el = scroller.value
    const prevHeight = el?.scrollHeight ?? 0
    const prevTop = el?.scrollTop ?? 0
    hasOlder.value = page.hasOlder || !serverExhausted.value
    bubbles.value = mergePagedBubbles(older, bubbles.value)
    await nextTick()
    if (el) el.scrollTop = prevTop + (el.scrollHeight - prevHeight)
  } finally {
    loadingOlder.value = false
  }
}

const onMessagesScroll = () => {
  const el = scroller.value
  if (!el || !hasOlder.value || loadingOlder.value) return
  const items = el.querySelectorAll<HTMLElement>('.bubble')
  if (items.length === 0) return
  // Trigger saat scroll ke atas melewati sekitar 40 pesan (~10 pesan sebelum pesan paling atas)
  const anchor = items[Math.min(CHAT_PREFETCH_OFFSET, items.length - 1)]!
  if (anchor.getBoundingClientRect().bottom >= el.getBoundingClientRect().top) {
    loadOlder().catch(() => undefined)
  }
}

const upsert = async (message: ChatMessage) => {
  if (deletedIds.value.has(message.client_msg_id) || message.seq <= clearedUpToSeq.value) return
  const myId = account.me?.id ?? ''
  allMessages.value = mergeCachedMessages(allMessages.value, [message], deletedIds.value, clearedUpToSeq.value)
  if (myId) {
    saveLocalMessages(myId, conversationId, [message]).catch(() => undefined)
  }
  const bubble = await toBubble(message)
  const index = bubbles.value.findIndex((b) => b.key === bubble.key)
  if (index >= 0) bubbles.value[index] = bubble
  else bubbles.value.push(bubble)
  bubbles.value.sort(compareBubbles)
}

const stopInbox = onInbox(async (event, payload) => {
  if (payload.conversation_id !== conversationId) return
  if (event === 'read') {
    peerReadSeq.value = Math.max(peerReadSeq.value, Number(payload.seq) || 0)
    return
  }
  await upsert(payload as unknown as ChatMessage)
  if (event === 'message_new') {
    if (payload.sender_id !== account.me?.id) presence?.clearPeerTyping()
    const c = conversation.value
    // balasan pertama dari lawan bicara = permintaan chat kita diterima
    if (c?.status === 'pending' && payload.sender_id === c.peer_id && c.requested_by === account.me?.id) {
      c.status = 'accepted'
    }
    await scrollToBottom()
    markRead()
  }
})
onBeforeUnmount(stopInbox)

const deliver = async (build: (retry: boolean) => Promise<SendParams>, bubble: Bubble, retry = false): Promise<void> => {
  const params = await build(retry)
  bubble.key = params.p_client_msg_id
  const result = await rpc<SendResult>('seru24_send_message', params)
  if (result.ok) {
    bubble.id = result.id ?? null
    bubble.seq = result.seq ?? bubble.seq
    bubble.createdAt = result.created_at ?? bubble.createdAt
    bubble.pending = false
    const myId = account.me?.id ?? ''
    const cachedMsg: ChatMessage = {
      id: result.id ?? params.p_client_msg_id,
      conversation_id: conversationId,
      sender_id: myId || null,
      seq: bubble.seq,
      client_msg_id: params.p_client_msg_id,
      kind: params.p_kind,
      ciphertext: params.p_ciphertext,
      nonce: params.p_nonce,
      sender_key_version: params.p_sender_key_version,
      recipient_key_version: params.p_recipient_key_version,
      reply_to: params.p_reply_to ?? null,
      created_at: bubble.createdAt,
      edited_at: null,
      deleted_at: null,
      expires_at: null,
    }
    allMessages.value = mergeCachedMessages(allMessages.value, [cachedMsg], deletedIds.value, clearedUpToSeq.value)
    if (myId) saveLocalMessages(myId, conversationId, [cachedMsg]).catch(() => undefined)
    if (result.id && result.code !== 'duplicate') {
      notifyMessageSent(conversationId, result.id)
    }
    return
  }
  if (result.code === 'stale_key' && !retry) {
    keyStatus.value = await checkPeerKey(peerId())
    return deliver(build, bubble, true)
  }
  bubble.pending = false
  bubble.failed = SEND_ERRORS[result.code ?? ''] ?? 'Pesan gagal dikirim'
}

const send = async () => {
  const text = draft.value.trim()
  if (!text || !conversation.value) return
  draft.value = ''
  error.value = ''
  const replyTo = replyingTo.value?.id ?? null
  replyingTo.value = null
  const bubble = localBubble(text, replyTo)
  bubbles.value.push(bubble)
  await scrollToBottom()
  try {
    await deliver(async (retry) => ({ ...(await encryptText(conversationId, peerId(), text, retry)), p_reply_to: replyTo }), bubble)
    if (isIncomingRequest(conversation.value)) conversation.value.status = 'accepted'
  } catch (e) {
    bubble.pending = false
    bubble.failed = e instanceof Error && e.message ? e.message : 'Pesan gagal dikirim'
  }
}

/** Dokumen dikirim satu per satu: enkripsi, unggah per potongan, lalu kirim pesan berisi kunci file (E2EE). */
const sendFile = async (file: File) => {
  const bubble = localBubble(`📎 ${safeFileName(file.name)}`)
  bubbles.value.push(bubble)
  await scrollToBottom()
  if (file.size > MAX_FILE_BYTES) {
    bubble.pending = false
    bubble.failed = `Maksimal ${formatFileSize(MAX_FILE_BYTES)} per file`
    return
  }
  let uploaded: FileMessageBody | null = null
  try {
    bubble.progress = 'Mengenkripsi…'
    uploaded = await uploadFile(conversationId, file, (done, total) => { bubble.progress = `Mengunggah ${percent(done, total)}` })
    bubble.file = uploaded
    bubble.progress = ''
    const meta = uploaded
    await deliver((retry) => encryptFile(conversationId, peerId(), meta, retry), bubble)
  } catch (e) {
    bubble.pending = false
    bubble.failed = e instanceof Error && e.message ? e.message : 'Dokumen gagal dikirim'
  } finally {
    bubble.progress = ''
  }
  // pesan gagal terkirim: jangan tinggalkan file yatim di Drive
  if (bubble.failed && uploaded) deleteRemoteFile(uploaded.id).catch(() => undefined)
}

const onFilesPicked = async (event: Event) => {
  const input = event.target as HTMLInputElement
  const files = [...(input.files ?? [])]
  input.value = ''
  error.value = ''
  for (const file of files) await sendFile(file)
}

const download = async (bubble: Bubble) => {
  if (!bubble.file || bubble.progress) return
  bubble.failed = ''
  try {
    await downloadFile(bubble.file, (done, total) => { bubble.progress = `Mengunduh ${percent(done, total)}` })
  } catch {
    bubble.failed = 'Dokumen gagal diunduh'
  } finally {
    bubble.progress = ''
  }
}

const removeMessage = async (bubble: Bubble) => {
  if (!bubble.id) return
  // file di Google Drive dihapus permanen lebih dulu; pesan tetap dihapus walau file sudah tidak ada
  if (bubble.file) await deleteRemoteFile(bubble.file.id).catch(() => undefined)
  if (await rpc<boolean>('seru24_delete_message', { p_message_id: bubble.id }).catch(() => false)) {
    bubble.deleted = true
    bubble.text = null
    bubble.file = null
    // Samakan cache lokal dengan server agar ciphertext pesan yang dihapus tidak tertinggal di browser.
    const cached = allMessages.value.find((m) => m.client_msg_id === bubble.key)
    if (cached) await upsert(markMessageDeleted(cached))
  }
}

const clearChatLocally = async () => {
  const myId = account.me?.id ?? ''
  const upTo = Math.max(lastSeq(), clearedUpToSeq.value)
  if (myId) {
    await clearLocalConversation(myId, conversationId, upTo)
  }
  clearedUpToSeq.value = upTo
  deletedIds.value.clear()
  allMessages.value = []
  bubbles.value = []
  hasOlder.value = false
}

const accept = async () => {
  if (await rpc<boolean>('seru24_accept_chat', { p_conversation_id: conversationId }).catch(() => false)) {
    conversation.value!.status = 'accepted'
  }
}

const toggleBlock = async () => {
  const c = conversation.value
  if (!c) return
  await rpc(c.peer_blocked ? 'seru24_unblock_user' : 'seru24_block_user', { p_target: c.peer_id })
  c.peer_blocked = !c.peer_blocked
}

const report = async () => {
  if (!reportReason.value || !conversation.value) return
  const result = await rpc<{ ok: boolean }>('seru24_report_user', {
    p_target: conversation.value.peer_id,
    p_reason: reportReason.value,
  }).catch(() => ({ ok: false }))
  reportDone.value = result.ok
  if (!result.ok) error.value = 'Laporan gagal dikirim'
}

const trustNewKey = async () => {
  await acceptPeerKey(peerId())
  keyStatus.value = await checkPeerKey(peerId())
}

const status = (b: Bubble) => bubbleStatus(b, peerReadSeq.value)

const startReply = (b: Bubble) => {
  replyingTo.value = b
  nextTick(() => document.querySelector<HTMLTextAreaElement>('.composer textarea')?.focus())
}

const subtitle = computed(() => {
  if (peerPresence.value.typing) return 'sedang mengetik…'
  const handle = `@${conversation.value?.peer_username ?? ''}`
  return peerPresence.value.online ? `${handle} · online` : `${handle} · terenkripsi end-to-end`
})

onMounted(() => load().catch(() => { error.value = 'Gagal memuat percakapan' }))
</script>

<template>
  <main v-if="conversation" class="chat">
    <header class="bar row">
      <NuxtLink to="/chats" class="back" aria-label="Kembali">←</NuxtLink>
      <div class="who">
        <strong>{{ peerLabel(conversation) }}</strong>
        <p class="muted" :class="{ typing: peerPresence.typing }">{{ subtitle }}</p>
      </div>
      <button type="button" @click="showSafety = !showSafety">Keamanan</button>
    </header>

    <section v-if="showSafety" class="panel stack">
      <div v-if="keyStatus.status !== 'missing'">
        <p class="muted">Kode keamanan. Cocokkan dengan yang tampil di perangkat lawan bicara:</p>
        <code class="code">{{ keyStatus.code }}</code>
      </div>
      <div class="row wrap">
        <button type="button" class="danger" @click="toggleBlock">
          {{ conversation.peer_blocked ? 'Buka blokir' : 'Blokir' }}
        </button>
        <select v-model="reportReason" aria-label="Alasan laporan">
          <option value="">Laporkan karena…</option>
          <option v-for="r in REPORT_REASONS" :key="r.value" :value="r.value">{{ r.label }}</option>
        </select>
        <button type="button" :disabled="!reportReason || reportDone" @click="report">
          {{ reportDone ? 'Terkirim' : 'Laporkan' }}
        </button>
        <button type="button" class="danger" @click="clearChatLocally">
          Hapus riwayat chat di browser ini
        </button>
      </div>
    </section>

    <p v-if="keyStatus.status === 'changed'" class="notice row wrap">
      Kunci enkripsi lawan bicara berubah. Cocokkan kode keamanan sebelum melanjutkan.
      <button type="button" @click="trustNewKey">Saya sudah cocokkan</button>
    </p>
    <p v-else-if="keyStatus.status === 'missing'" class="notice">
      Lawan bicara belum menyiapkan kunci enkripsi, jadi pesan belum bisa dikirim.
    </p>
    <p v-if="isIncomingRequest(conversation)" class="notice row wrap">
      @{{ conversation.peer_username }} ingin mengirim pesan kepada Anda.
      <button type="button" class="primary" @click="accept">Terima</button>
      <button type="button" class="danger" @click="toggleBlock">Blokir</button>
    </p>

    <div ref="scroller" class="messages" @scroll.passive="onMessagesScroll">
      <p v-if="loadingOlder" class="older muted">Memuat pesan lama…</p>
      <button v-else-if="hasOlder" type="button" class="older" @click="loadOlder">Muat pesan lama</button>
      <div v-for="b in bubbles" :key="b.key" class="bubble" :class="{ mine: b.mine, failed: b.failed }">
        <div v-if="b.replyTo && !b.deleted" class="quote">
          <strong v-if="quoteOf(b).who">{{ quoteOf(b).who }}</strong>
          <span>{{ quoteOf(b).snippet }}</span>
        </div>
        <p v-if="b.deleted" class="muted"><em>Pesan dihapus</em></p>
        <p v-else-if="b.text === null" class="muted"><em>Pesan tidak dapat dibuka</em></p>
        <div v-else-if="b.file" class="doc row">
          <span class="doc-icon" aria-hidden="true">📎</span>
          <span class="doc-info">
            <strong class="doc-name">{{ b.file.name }}</strong>
            <span class="muted">{{ formatFileSize(b.file.size) }}</span>
          </span>
          <button type="button" class="doc-get" :disabled="Boolean(b.progress) || b.pending" @click="download(b)">Unduh</button>
        </div>
        <p v-else class="text">{{ b.text }}</p>
        <p v-if="b.progress" class="muted progress">{{ b.progress }}</p>
        <div class="foot row">
          <span class="muted">{{ status(b).text }}</span>
          <span
            v-if="status(b).ticks"
            class="ticks"
            :class="{ read: status(b).read }"
            :aria-label="status(b).read ? 'Dibaca' : 'Terkirim'"
          >{{ status(b).ticks }}</span>
          <button
            v-if="b.id && !b.pending && !b.deleted"
            type="button"
            class="icon-reply"
            aria-label="Balas pesan"
            title="Balas"
            @click="startReply(b)"
          >↩</button>
          <button
            v-if="b.mine && b.id && !b.deleted"
            type="button"
            class="icon-del"
            aria-label="Hapus pesan"
            title="Hapus pesan"
            @click="removeMessage(b)"
          >&times;</button>
        </div>
      </div>
    </div>

    <p v-if="error" class="error" role="alert">{{ error }}</p>
    <div v-if="replyingTo" class="replying row">
      <div class="quote grow">
        <strong>Membalas {{ replyingTo.mine ? 'diri sendiri' : peerLabel(conversation) }}</strong>
        <span>{{ replySnippet(replyingTo) }}</span>
      </div>
      <button type="button" class="icon-del" aria-label="Batal membalas" title="Batal" @click="replyingTo = null">&times;</button>
    </div>
    <form class="composer row" @submit.prevent="send">
      <input ref="fileInput" type="file" multiple hidden @change="onFilesPicked">
      <button
        type="button"
        class="attach"
        aria-label="Kirim dokumen"
        title="Kirim dokumen (maks 50 MB per file)"
        :disabled="keyStatus.status === 'missing' || conversation.peer_blocked"
        @click="fileInput?.click()"
      >📎</button>
      <textarea
        v-model="draft"
        rows="1"
        :maxlength="MAX_TEXT_LENGTH"
        placeholder="Tulis pesan"
        :disabled="keyStatus.status === 'missing' || conversation.peer_blocked"
        @keydown.enter.exact.prevent="send"
        @input="presence?.notifyTyping()"
      />
      <button class="primary" type="submit" :disabled="!draft.trim() || keyStatus.status === 'missing'">Kirim</button>
    </form>
  </main>
  <p v-else-if="error" class="error" style="padding: 16px">{{ error }}</p>
</template>

<style scoped>
.chat {
  max-width: 760px;
  height: 100dvh;
  margin: 0 auto;
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 12px 16px;
}
.bar { gap: 12px; }
.back { font-size: 20px; text-decoration: none; padding: 4px 8px; }
.who { flex: 1; min-width: 0; }
.who p { margin: 0; }
.panel { padding: 12px; background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); }
.panel select { width: auto; }
.code { display: block; font-size: 16px; letter-spacing: 1px; word-break: break-word; }
.wrap { flex-wrap: wrap; }
.messages {
  flex: 1;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 4px 2px;
}
.older { align-self: center; font-size: 13px; }
.bubble {
  max-width: 78%;
  padding: 8px 12px;
  border-radius: 14px;
  background: var(--theirs);
  border: 1px solid var(--border);
  align-self: flex-start;
}
.bubble.mine { align-self: flex-end; background: var(--mine); }
.bubble.failed { border-color: var(--danger); }
.bubble p { margin: 0; }
.text { white-space: pre-wrap; overflow-wrap: anywhere; }
.foot { justify-content: flex-end; gap: 8px; }
.foot .muted { font-size: 11px; }
.icon-del { padding: 0 2px; border: 0; background: none; color: var(--muted); font-size: 15px; line-height: 1; cursor: pointer; }
.icon-del:hover { color: var(--danger); }
.icon-reply { padding: 0 2px; border: 0; background: none; color: var(--muted); font-size: 14px; line-height: 1; cursor: pointer; }
.icon-reply:hover { color: var(--accent, #0f766e); }
.ticks { font-size: 12px; letter-spacing: -3px; color: var(--muted); margin-right: 2px; }
.ticks.read { color: #0d9488; font-weight: 700; }
.quote { display: flex; flex-direction: column; gap: 1px; padding: 4px 8px; margin-bottom: 4px; border-left: 3px solid #14b8a6; border-radius: 6px; background: rgba(15, 118, 110, 0.08); font-size: 12px; overflow-wrap: anywhere; }
.quote strong { color: #0f766e; }
.replying { gap: 8px; align-items: center; }
.replying .grow { flex: 1; min-width: 0; margin-bottom: 0; }
.typing { color: #0f766e; font-style: italic; }
.composer textarea { flex: 1; resize: none; max-height: 140px; }
.attach { padding: 6px 10px; font-size: 18px; line-height: 1; }
.doc { gap: 10px; align-items: center; }
.doc-icon { font-size: 22px; }
.doc-info { display: flex; flex-direction: column; min-width: 0; }
.doc-name { overflow-wrap: anywhere; }
.doc-get { padding: 4px 10px; font-size: 13px; }
.progress { font-size: 12px; }
</style>
