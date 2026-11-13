<script setup lang="ts">
import { MAX_TEXT_LENGTH } from '#shared/crypto'
import {
  CHAT_PAGE_SIZE,
  CHAT_PREFETCH_OFFSET,
  mergePagedBubbles,
  oldestPersistedSeq,
} from '#shared/chat-core'

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
}

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
})

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
  const list = await listConversations()
  conversation.value = list.find((c) => c.id === conversationId) ?? null
  if (!conversation.value) {
    await navigateTo('/chats')
    return
  }
  keyStatus.value = await checkPeerKey(peerId())
  const rows = await fetchPage()
  hasOlder.value = rows.length === CHAT_PAGE_SIZE
  bubbles.value = await Promise.all(rows.reverse().map(toBubble))
  await scrollToBottom()
  markRead()
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
    const rows = await fetchPage(beforeSeq)
    const older = await Promise.all(rows.reverse().map(toBubble))
    const el = scroller.value
    const prevHeight = el?.scrollHeight ?? 0
    const prevTop = el?.scrollTop ?? 0
    hasOlder.value = rows.length === CHAT_PAGE_SIZE
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
  const bubble = await toBubble(message)
  const index = bubbles.value.findIndex((b) => b.key === bubble.key)
  if (index >= 0) bubbles.value[index] = bubble
  else bubbles.value.push(bubble)
  bubbles.value.sort((a, b) => (a.pending ? Infinity : a.seq) - (b.pending ? Infinity : b.seq))
}

const stopInbox = onInbox(async (event, payload) => {
  if (payload.conversation_id !== conversationId) return
  if (event === 'read') {
    peerReadSeq.value = Math.max(peerReadSeq.value, Number(payload.seq) || 0)
    return
  }
  await upsert(payload as unknown as ChatMessage)
  if (event === 'message_new') {
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

const sendText = async (text: string, bubble: Bubble, retry = false): Promise<void> => {
  const params = await encryptText(conversationId, peerId(), text, retry)
  bubble.key = params.p_client_msg_id
  const result = await rpc<SendResult>('seru24_send_message', params)
  if (result.ok) {
    bubble.id = result.id ?? null
    bubble.seq = result.seq ?? bubble.seq
    bubble.createdAt = result.created_at ?? bubble.createdAt
    bubble.pending = false
    if (result.id && result.code !== 'duplicate') {
      notifyMessageSent(conversationId, result.id)
    }
    return
  }
  if (result.code === 'stale_key' && !retry) {
    keyStatus.value = await checkPeerKey(peerId())
    return sendText(text, bubble, true)
  }
  bubble.pending = false
  bubble.failed = SEND_ERRORS[result.code ?? ''] ?? 'Pesan gagal dikirim'
}

const send = async () => {
  const text = draft.value.trim()
  if (!text || !conversation.value) return
  draft.value = ''
  error.value = ''
  const bubble = reactive<Bubble>({
    key: `local-${Date.now()}`, id: null, seq: 0, mine: true, text,
    createdAt: new Date().toISOString(), deleted: false, pending: true, failed: '',
  })
  bubbles.value.push(bubble)
  await scrollToBottom()
  try {
    await sendText(text, bubble)
    if (isIncomingRequest(conversation.value)) conversation.value.status = 'accepted'
  } catch (e) {
    bubble.pending = false
    bubble.failed = e instanceof Error && e.message ? e.message : 'Pesan gagal dikirim'
  }
}

const removeMessage = async (bubble: Bubble) => {
  if (!bubble.id) return
  if (await rpc<boolean>('seru24_delete_message', { p_message_id: bubble.id }).catch(() => false)) {
    bubble.deleted = true
    bubble.text = null
  }
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

const status = (b: Bubble) => {
  if (b.pending) return 'mengirim…'
  if (b.failed) return b.failed
  return b.mine && b.seq <= peerReadSeq.value ? 'dibaca' : formatTime(b.createdAt)
}

onMounted(() => load().catch(() => { error.value = 'Gagal memuat percakapan' }))
</script>

<template>
  <main v-if="conversation" class="chat">
    <header class="bar row">
      <NuxtLink to="/chats" class="back" aria-label="Kembali">←</NuxtLink>
      <div class="who">
        <strong>{{ peerLabel(conversation) }}</strong>
        <p class="muted">@{{ conversation.peer_username }} · terenkripsi end-to-end</p>
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
        <p v-if="b.deleted" class="muted"><em>Pesan dihapus</em></p>
        <p v-else-if="b.text === null" class="muted"><em>Pesan tidak dapat dibuka</em></p>
        <p v-else class="text">{{ b.text }}</p>
        <div class="foot row">
          <span class="muted">{{ status(b) }}</span>
          <button v-if="b.mine && b.id && !b.deleted" type="button" class="link" @click="removeMessage(b)">Hapus</button>
        </div>
      </div>
    </div>

    <p v-if="error" class="error" role="alert">{{ error }}</p>
    <form class="composer row" @submit.prevent="send">
      <textarea
        v-model="draft"
        rows="1"
        :maxlength="MAX_TEXT_LENGTH"
        placeholder="Tulis pesan"
        :disabled="keyStatus.status === 'missing' || conversation.peer_blocked"
        @keydown.enter.exact.prevent="send"
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
.link { padding: 0; border: 0; background: none; color: var(--muted); font-size: 11px; text-decoration: underline; }
.composer textarea { flex: 1; resize: none; max-height: 140px; }
</style>
