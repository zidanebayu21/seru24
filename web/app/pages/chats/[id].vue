<script setup lang="ts">
import { MAX_TEXT_LENGTH, randomId } from '#shared/crypto'
import {
  CHAT_PAGE_SIZE,
  CHAT_PREFETCH_OFFSET,
  bubbleStatus,
  compareBubbles,
  formatClock,
  formatDayLabel,
  isSameDay,
  markMessageDeleted,
  mergeCachedMessages,
  mergePagedBubbles,
  oldestPersistedSeq,
  replySnippet,
  sliceMessagesPage,
} from '#shared/chat-core'
import { createConversationPresence, type PeerPresence } from '#shared/presence-core'
import {
  createTransferMeter,
  formatClockSeconds,
  formatFileSize,
  isVoiceFile,
  safeFileName,
  splitByFileLimit,
  voiceSecondsFromName,
  type FileMessageBody,
} from '#shared/file-core'

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
  /** Bar progres 0..1 untuk unggah/unduh dokumen. */
  fraction?: number
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
  ensureSupabase().then((client) => {
    if (closed) return
    presence = createConversationPresence(client, conversationId, myId, (state) => { peerPresence.value = state })
  }, () => undefined)
}
let closed = false
onBeforeUnmount(() => {
  closed = true
  presence?.close()
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
  const myId = account.me?.id ?? ''
  // pesan terbaru diminta bersamaan dengan data percakapan (tidak saling menunggu); hasilnya dipakai di bawah
  const firstPage = fetchPage().then((rows) => ({ rows }), (cause: unknown) => ({ cause }))
  let list: Conversation[] = []
  try {
    // satu percakapan saja: yang dibuka bisa ada di luar halaman daftar chat yang sudah dimuat
    list = await listConversations({ id: conversationId })
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
    const first = await firstPage
    if ('cause' in first) throw first.cause
    const rows = first.rows
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
const sendFile = async (file: File, label?: string) => {
  const bubble = localBubble(label ?? `📎 ${safeFileName(file.name)}`)
  bubbles.value.push(bubble)
  await scrollToBottom()
  let uploaded: FileMessageBody | null = null
  try {
    bubble.progress = 'Mengenkripsi…'
    const meter = createTransferMeter('Mengunggah')
    uploaded = await uploadFile(conversationId, file, (done, total) => {
      const status = meter(done, total)
      bubble.progress = status.label
      bubble.fraction = status.fraction
    })
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

const sendPickedFiles = async (files: File[]) => {
  error.value = ''
  // file di atas batas tidak dibuat sebagai pesan (tidak bisa dihapus dari daftar): cukup popup
  const { allowed, message } = splitByFileLimit(files)
  if (message) window.alert(message)
  for (const file of allowed) await sendFile(file)
}

const onFilesPicked = async (event: Event) => {
  const input = event.target as HTMLInputElement
  const files = [...(input.files ?? [])]
  input.value = ''
  await sendPickedFiles(files)
}

// ---- seret dan lepas file ke halaman chat ----

const dragging = ref(false)
let dragDepth = 0

const canSendFiles = () => !recording.value && keyStatus.value.status !== 'missing' && !conversation.value?.peer_blocked

const hasFiles = (event: DragEvent) => Array.from(event.dataTransfer?.types ?? []).includes('Files')

/** File saja; folder yang diseret dilewati karena tidak bisa dikirim sebagai dokumen. */
const droppedFiles = (event: DragEvent): File[] =>
  Array.from(event.dataTransfer?.items ?? [])
    .filter((item) => item.kind === 'file' && !item.webkitGetAsEntry?.()?.isDirectory)
    .map((item) => item.getAsFile())
    .filter((file): file is File => file !== null)

const onWindowDragEnter = (event: DragEvent) => {
  if (!hasFiles(event)) return
  dragDepth += 1
  dragging.value = canSendFiles()
}

const onWindowDragLeave = (event: DragEvent) => {
  if (!hasFiles(event)) return
  dragDepth = Math.max(0, dragDepth - 1)
  if (dragDepth === 0) dragging.value = false
}

// preventDefault di seluruh jendela: file yang terlepas di luar area chat tidak membuka tab baru dan meninggalkan chat
const onWindowDragOver = (event: DragEvent) => {
  if (hasFiles(event)) event.preventDefault()
}

const onWindowDrop = async (event: DragEvent) => {
  if (!hasFiles(event)) return
  event.preventDefault()
  dragDepth = 0
  dragging.value = false
  if (!canSendFiles()) {
    error.value = 'File tidak bisa dikirim ke percakapan ini sekarang'
    return
  }
  await sendPickedFiles(droppedFiles(event))
}

onMounted(() => {
  window.addEventListener('dragenter', onWindowDragEnter)
  window.addEventListener('dragleave', onWindowDragLeave)
  window.addEventListener('dragover', onWindowDragOver)
  window.addEventListener('drop', onWindowDrop)
})

onBeforeUnmount(() => {
  window.removeEventListener('dragenter', onWindowDragEnter)
  window.removeEventListener('dragleave', onWindowDragLeave)
  window.removeEventListener('dragover', onWindowDragOver)
  window.removeEventListener('drop', onWindowDrop)
})

const download = async (bubble: Bubble) => {
  if (!bubble.file || bubble.progress) return
  bubble.failed = ''
  try {
    const meter = createTransferMeter('Mengunduh')
    await downloadFile(bubble.file, (done, total) => {
      const status = meter(done, total)
      bubble.progress = status.label
      bubble.fraction = status.fraction
    })
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

/** Hapus pesan bersifat permanen untuk kedua pihak (dokumen ikut dihapus dari server): minta konfirmasi dulu. */
const confirmRemove = (bubble: Bubble) => {
  const what = bubble.file ? 'dokumen ini? File juga dihapus permanen dari server' : 'pesan ini?'
  if (window.confirm(`Hapus ${what}\nBerlaku untuk kedua pihak dan tidak bisa dibatalkan.`)) void removeMessage(bubble)
}

const confirmClearChat = async () => {
  if (window.confirm('Hapus riwayat chat di browser ini?\nPesan di server dan di perangkat lain tidak ikut terhapus.')) await clearChatLocally()
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

const status = (b: Bubble) => {
  const result = bubbleStatus(b, peerReadSeq.value)
  // tanggal sudah ada di pemisah hari; gelembung cukup menampilkan jam
  return b.pending || b.failed ? result : { ...result, text: formatClock(b.createdAt) }
}

const dayLabelAt = (index: number): string => {
  const current = bubbles.value[index]
  const previous = bubbles.value[index - 1]
  if (!current || (previous && isSameDay(previous.createdAt, current.createdAt))) return ''
  return formatDayLabel(current.createdAt)
}

/** Pesan beruntun dari pengirim yang sama di hari yang sama dirapatkan. */
const isTight = (index: number): boolean => {
  const current = bubbles.value[index]
  const previous = bubbles.value[index - 1]
  return Boolean(current && previous && current.mine === previous.mine && isSameDay(previous.createdAt, current.createdAt))
}

// ---- pesan suara ----

const recording = ref(false)
const recordSeconds = ref(0)
let recorder: VoiceRecording | null = null
let recordTicker: ReturnType<typeof setInterval> | undefined

const resetRecording = () => {
  clearInterval(recordTicker)
  recorder = null
  recording.value = false
  recordSeconds.value = 0
}

const startRecording = async () => {
  error.value = ''
  try {
    const started = await startVoiceRecording(() => { void finishRecording() })
    recorder = started
    recording.value = true
    recordTicker = setInterval(() => { recordSeconds.value = Math.floor((Date.now() - started.startedAt) / 1000) }, 250)
  } catch {
    error.value = 'Mikrofon tidak bisa dipakai. Izinkan akses mikrofon untuk situs ini di pengaturan browser.'
  }
}

const cancelRecording = () => {
  recorder?.cancel()
  resetRecording()
}

const finishRecording = async () => {
  const current = recorder
  if (!current) return
  resetRecording()
  const file = await current.stop()
  if (file) await sendFile(file, 'Pesan suara')
}

interface Player {
  state: 'idle' | 'loading' | 'playing' | 'paused'
  current: number
}

const players = reactive<Record<string, Player>>({})
const audios = new Map<string, { audio: HTMLAudioElement; url: string }>()

const playerOf = (b: Bubble): Player => (players[b.key] ??= { state: 'idle', current: 0 })

const voiceDuration = (b: Bubble) => (b.file ? voiceSecondsFromName(b.file.name) : null)

const voiceLabel = (b: Bubble) => {
  const player = playerOf(b)
  const total = voiceDuration(b)
  if (player.state === 'loading') return 'Memuat…'
  const shown = player.state === 'idle' ? (total ?? 0) : player.current
  return formatClockSeconds(shown)
}

const voiceProgress = (b: Bubble) => {
  const total = voiceDuration(b)
  return total ? Math.min(100, (playerOf(b).current / total) * 100) : 0
}

const pauseOthers = (exceptKey: string) => {
  for (const [key, { audio }] of audios) {
    if (key !== exceptKey && !audio.paused) audio.pause()
  }
}

const togglePlay = async (b: Bubble) => {
  if (!b.file) return
  const player = playerOf(b)
  if (player.state === 'loading') return
  let entry = audios.get(b.key)
  if (!entry) {
    player.state = 'loading'
    try {
      const url = await fetchAudioUrl(b.file)
      const audio = new Audio(url)
      audio.addEventListener('timeupdate', () => { player.current = audio.currentTime })
      audio.addEventListener('play', () => { player.state = 'playing' })
      audio.addEventListener('pause', () => { if (!audio.ended) player.state = 'paused' })
      audio.addEventListener('ended', () => { player.state = 'idle'; player.current = 0 })
      entry = { audio, url }
      audios.set(b.key, entry)
    } catch {
      player.state = 'idle'
      b.failed = 'Pesan suara gagal dimuat'
      return
    }
  }
  if (entry.audio.paused) {
    pauseOthers(b.key)
    await entry.audio.play().catch(() => { player.state = 'idle' })
  } else {
    entry.audio.pause()
  }
}

const releaseAudio = () => {
  for (const { audio, url } of audios.values()) {
    audio.pause()
    URL.revokeObjectURL(url)
  }
  audios.clear()
}

onBeforeUnmount(() => {
  cancelRecording()
  releaseAudio()
})

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
    <div v-if="dragging" class="drop" aria-hidden="true">
      <div class="drop-card">
        <svg viewBox="0 0 24 24" width="40" height="40" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M12 16V4" /><path d="M7 9l5-5 5 5" /><path d="M5 20h14" /></svg>
        <strong>Lepaskan untuk mengirim</strong>
        <span class="muted">ke {{ peerLabel(conversation) }} · maks 50 MB per file</span>
      </div>
    </div>
    <header class="bar row">
      <NuxtLink to="/chats" class="back" aria-label="Kembali">
        <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 5l-7 7 7 7" /></svg>
      </NuxtLink>
      <Avatar :name="peerLabel(conversation)" :seed="conversation.peer_username" :size="40" />
      <div class="who">
        <strong>{{ peerLabel(conversation) }}</strong>
        <p class="muted" :class="{ typing: peerPresence.typing }">{{ subtitle }}</p>
      </div>
      <button type="button" class="ghost" :aria-expanded="showSafety" @click="showSafety = !showSafety">Keamanan</button>
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
        <button type="button" class="danger" @click="confirmClearChat">
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
      <template v-for="(b, i) in bubbles" :key="b.key">
      <div v-if="dayLabelAt(i)" class="day"><span>{{ dayLabelAt(i) }}</span></div>
      <div class="bubble" :class="{ mine: b.mine, failed: b.failed, tight: isTight(i) }">
        <div v-if="b.replyTo && !b.deleted" class="quote">
          <strong v-if="quoteOf(b).who">{{ quoteOf(b).who }}</strong>
          <span>{{ quoteOf(b).snippet }}</span>
        </div>
        <p v-if="b.deleted" class="muted"><em>Pesan dihapus</em></p>
        <p v-else-if="b.text === null" class="muted"><em>Pesan tidak dapat dibuka</em></p>
        <div v-else-if="b.file && isVoiceFile(b.file)" class="voice">
          <button
            type="button"
            class="voice-btn"
            :disabled="b.pending"
            :aria-label="playerOf(b).state === 'playing' ? 'Jeda' : 'Putar pesan suara'"
            @click="togglePlay(b)"
          >
            <svg v-if="playerOf(b).state === 'playing'" viewBox="0 0 24 24" width="18" height="18" fill="currentColor"><rect x="6" y="5" width="4" height="14" rx="1" /><rect x="14" y="5" width="4" height="14" rx="1" /></svg>
            <svg v-else viewBox="0 0 24 24" width="18" height="18" fill="currentColor"><path d="M8 5.5v13a1 1 0 0 0 1.5.86l10.5-6.5a1 1 0 0 0 0-1.72L9.5 4.64A1 1 0 0 0 8 5.5z" /></svg>
          </button>
          <div class="voice-track" aria-hidden="true"><div class="voice-fill" :style="{ width: voiceProgress(b) + '%' }" /></div>
          <span class="voice-time">{{ voiceLabel(b) }}</span>
        </div>
        <div v-else-if="b.file" class="doc row">
          <span class="doc-icon" aria-hidden="true">
            <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" /><path d="M14 3v5h5" /></svg>
          </span>
          <span class="doc-info">
            <strong class="doc-name">{{ b.file.name }}</strong>
            <span class="muted">{{ formatFileSize(b.file.size) }}</span>
          </span>
          <button type="button" class="doc-get" :disabled="Boolean(b.progress) || b.pending" @click="download(b)">
            <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 4v11" /><path d="M7 11l5 5 5-5" /><path d="M5 20h14" /></svg>
            Unduh
          </button>
        </div>
        <p v-else class="text">{{ b.text }}</p>
        <p v-if="b.progress" class="muted progress">{{ b.progress }}</p>
        <div v-if="b.progress && b.fraction !== undefined" class="meter" role="progressbar" :aria-valuenow="Math.round(b.fraction * 100)" aria-valuemin="0" aria-valuemax="100">
          <div class="meter-fill" :style="{ width: Math.round(b.fraction * 100) + '%' }" />
        </div>
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
          >
            <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10 8L5 13l5 5" /><path d="M5 13h9a5 5 0 0 1 5 5" /></svg>
          </button>
          <button
            v-if="b.mine && b.id && !b.deleted"
            type="button"
            class="icon-del"
            aria-label="Hapus pesan"
            title="Hapus pesan"
            @click="confirmRemove(b)"
          >
            <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7h16" /><path d="M9 7V4h6v3" /><path d="M6 7l1 13h10l1-13" /></svg>
          </button>
        </div>
      </div>
      </template>
    </div>

    <p v-if="error" class="error" role="alert">{{ error }}</p>
    <div v-if="replyingTo" class="replying row">
      <div class="quote grow">
        <strong>Membalas {{ replyingTo.mine ? 'diri sendiri' : peerLabel(conversation) }}</strong>
        <span>{{ replySnippet(replyingTo) }}</span>
      </div>
      <button type="button" class="icon-del" aria-label="Batal membalas" title="Batal" @click="replyingTo = null">&times;</button>
    </div>
    <div v-if="recording" class="composer row recording" role="group" aria-label="Merekam pesan suara">
      <button type="button" class="attach" aria-label="Batalkan rekaman" title="Batalkan" @click="cancelRecording">
        <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7h16" /><path d="M9 7V4h6v3" /><path d="M6 7l1 13h10l1-13" /></svg>
      </button>
      <span class="rec-dot" aria-hidden="true" />
      <span class="rec-time" aria-live="off">{{ formatClockSeconds(recordSeconds) }}</span>
      <span class="rec-hint muted">Merekam…</span>
      <button type="button" class="primary send" aria-label="Kirim pesan suara" @click="finishRecording">
        <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14" /><path d="M13 6l6 6-6 6" /></svg>
      </button>
    </div>
    <form v-else class="composer row" @submit.prevent="send">
      <input ref="fileInput" type="file" multiple hidden @change="onFilesPicked">
      <button
        type="button"
        class="attach"
        aria-label="Kirim dokumen"
        title="Kirim dokumen (maks 50 MB per file)"
        :disabled="keyStatus.status === 'missing' || conversation.peer_blocked"
        @click="fileInput?.click()"
      >
        <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M21 11.5l-8.6 8.6a5.5 5.5 0 0 1-7.8-7.8l8.6-8.6a3.7 3.7 0 0 1 5.2 5.2l-8.6 8.6a1.8 1.8 0 0 1-2.6-2.6l7.9-7.9" /></svg>
      </button>
      <textarea
        v-model="draft"
        rows="1"
        :maxlength="MAX_TEXT_LENGTH"
        placeholder="Tulis pesan"
        :disabled="keyStatus.status === 'missing' || conversation.peer_blocked"
        @keydown.enter.exact.prevent="send"
        @input="presence?.notifyTyping()"
      />
      <button
        v-if="!draft.trim() && canRecordVoice()"
        type="button"
        class="primary send"
        aria-label="Rekam pesan suara"
        title="Rekam pesan suara"
        :disabled="keyStatus.status === 'missing' || conversation.peer_blocked"
        @click="startRecording"
      >
        <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="3" width="6" height="11" rx="3" /><path d="M5 11a7 7 0 0 0 14 0" /><path d="M12 18v3" /></svg>
      </button>
      <button v-else class="primary send" type="submit" aria-label="Kirim pesan" :disabled="!draft.trim() || keyStatus.status === 'missing'">
        <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14" /><path d="M13 6l6 6-6 6" /></svg>
      </button>
    </form>
  </main>
  <main v-else-if="!error" class="chat" aria-busy="true" aria-label="Memuat percakapan">
    <header class="bar row">
      <span class="sk sk-circle" />
      <div class="who"><span class="sk sk-line" /></div>
    </header>
    <div class="messages">
      <span class="sk sk-bubble" />
      <span class="sk sk-bubble sk-mine" />
      <span class="sk sk-bubble" />
    </div>
  </main>
  <p v-else class="error" style="padding: 16px">{{ error }}</p>
</template>

<style scoped>
.chat {
  max-width: 760px;
  height: 100dvh;
  margin: 0 auto;
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 10px 14px 14px;
}
.chat > :not(.messages) { flex: none; }
.bar { gap: 10px; padding-bottom: 8px; border-bottom: 1px solid var(--border); }
.back { display: grid; place-items: center; width: 36px; height: 36px; margin-left: -6px; border-radius: 50%; color: var(--text); }
.back:hover { background: color-mix(in srgb, var(--text) 8%, transparent); }
.ghost { min-height: 34px; padding: 5px 12px; border-color: transparent; background: transparent; color: var(--muted); font-size: 13px; }
.ghost:hover:not(:disabled), .ghost[aria-expanded="true"] { background: color-mix(in srgb, var(--text) 7%, transparent); border-color: transparent; }
.who { flex: 1; min-width: 0; }
.who p { margin: 0; }
.panel { padding: 12px; background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); }
.panel select { width: auto; }
.code { display: block; font-size: 16px; letter-spacing: 1px; word-break: break-word; }
.wrap { flex-wrap: wrap; }
.messages {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 8px 4px;
  scrollbar-width: thin;
  scrollbar-color: color-mix(in srgb, var(--text) 25%, transparent) transparent;
}
.day { align-self: center; margin: 10px 0 4px; }
.day span {
  display: inline-block;
  padding: 3px 12px;
  border-radius: 999px;
  background: color-mix(in srgb, var(--text) 8%, transparent);
  color: var(--muted);
  font-size: 12px;
  font-weight: 500;
}
.bubble.tight { margin-top: -3px; }
.older { align-self: center; font-size: 13px; }
.bubble {
  max-width: min(78%, 34rem);
  padding: 7px 11px 5px;
  border-radius: 16px 16px 16px 5px;
  background: var(--theirs);
  box-shadow: 0 1px 1px rgb(0 0 0 / 7%), 0 0 0 1px color-mix(in srgb, var(--border) 70%, transparent);
  align-self: flex-start;
}
.bubble.mine { align-self: flex-end; border-radius: 16px 16px 5px 16px; background: var(--mine); box-shadow: 0 1px 1px rgb(0 0 0 / 5%); }
.bubble.failed { box-shadow: 0 0 0 1.5px var(--danger); }
.bubble p { margin: 0; }
.text { white-space: pre-wrap; overflow-wrap: anywhere; }
.foot { width: 100%; justify-content: flex-end; gap: 6px; min-height: 18px; }
.foot .muted { font-size: 11px; }
/* tombol balas/hapus mengambang di samping gelembung (muncul saat disorot) agar tidak menggeser jam */
.bubble { position: relative; }
.icon-del, .icon-reply {
  position: absolute;
  top: 50%;
  display: grid;
  place-items: center;
  width: 30px;
  height: 30px;
  min-height: 30px;
  margin-top: -15px;
  padding: 0;
  border: 0 solid transparent;
  border-radius: 8px;
  background: none;
  background-clip: padding-box;
  color: var(--muted);
  opacity: 0;
  transition: opacity .12s, color .12s, background-color .12s;
}
.bubble:not(.mine) .icon-reply { left: 100%; border-left-width: 6px; }
.bubble.mine .icon-reply { right: 100%; border-right-width: 6px; }
.bubble.mine .icon-del { right: calc(100% + 30px); }
.bubble:hover .icon-del, .bubble:hover .icon-reply, .icon-del:focus-visible, .icon-reply:focus-visible { opacity: 1; }
@media (hover: none) { .icon-del, .icon-reply { opacity: .7; } }
.icon-del:hover { color: var(--danger); background-color: color-mix(in srgb, var(--danger) 10%, transparent); }
.icon-reply:hover { color: var(--accent); background-color: color-mix(in srgb, var(--accent) 12%, transparent); }
.ticks { font-size: 12px; letter-spacing: -3px; color: var(--muted); margin-right: 2px; }
.ticks.read { color: var(--accent); font-weight: 700; }
.quote { display: flex; flex-direction: column; gap: 1px; padding: 4px 8px; margin-bottom: 4px; border-left: 3px solid var(--accent); border-radius: 6px; background: var(--quote-bg); font-size: 12px; overflow-wrap: anywhere; }
.quote strong { color: var(--accent); }
.replying { gap: 8px; align-items: center; }
.replying .grow { flex: 1; min-width: 0; margin-bottom: 0; }
.typing { color: var(--accent); font-style: italic; }
.composer {
  align-items: flex-end;
  gap: 4px;
  padding: 5px 5px 5px 6px;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 26px;
  transition: border-color .15s, box-shadow .15s;
}
.composer:focus-within { border-color: var(--accent); box-shadow: 0 0 0 3px color-mix(in srgb, var(--accent) 18%, transparent); }
.composer textarea { flex: 1; min-height: 40px; resize: none; max-height: 140px; padding: 9px 6px; border: 0; background: transparent; box-shadow: none; }
.composer textarea:focus { box-shadow: none; }
.attach, .send { display: grid; place-items: center; flex: none; width: 40px; min-height: 40px; height: 40px; padding: 0; border-radius: 50%; }
.attach { border-color: transparent; background: transparent; color: var(--muted); }
.attach:hover:not(:disabled) { border-color: transparent; background: color-mix(in srgb, var(--text) 8%, transparent); color: var(--text); }
.voice { display: flex; align-items: center; gap: 10px; min-width: min(15rem, 60vw); }
.voice-btn { display: grid; place-items: center; flex: none; width: 36px; min-height: 36px; height: 36px; padding: 0; border: 0; border-radius: 50%; background: var(--accent); color: var(--accent-text); }
.voice-btn:hover:not(:disabled) { background: color-mix(in srgb, var(--accent) 88%, #000); }
.voice-track { flex: 1; height: 4px; border-radius: 2px; overflow: hidden; background: color-mix(in srgb, var(--text) 15%, transparent); }
.voice-fill { height: 100%; background: var(--accent); }
.voice-time { flex: none; min-width: 2.6em; text-align: right; color: var(--muted); font-size: 12px; font-variant-numeric: tabular-nums; }
.drop {
  position: fixed;
  inset: 0;
  z-index: 30;
  display: grid;
  place-items: center;
  background: color-mix(in srgb, var(--bg) 80%, transparent);
  backdrop-filter: blur(3px);
  pointer-events: none;
}
.drop-card {
  display: grid;
  justify-items: center;
  gap: 6px;
  padding: 34px 52px;
  border: 2px dashed var(--accent);
  border-radius: 22px;
  background: var(--surface);
  color: var(--accent);
}
.drop-card strong { color: var(--text); font-size: 17px; }
.sk { display: block; background: linear-gradient(90deg, color-mix(in srgb, var(--text) 7%, transparent) 25%, color-mix(in srgb, var(--text) 13%, transparent) 50%, color-mix(in srgb, var(--text) 7%, transparent) 75%); background-size: 200% 100%; animation: sk-shimmer 1.4s ease-in-out infinite; }
.sk-circle { width: 40px; height: 40px; border-radius: 50%; }
.sk-line { width: 9rem; height: 14px; border-radius: 7px; }
.sk-bubble { width: 55%; height: 44px; border-radius: 16px 16px 16px 5px; }
.sk-bubble.sk-mine { align-self: flex-end; width: 40%; border-radius: 16px 16px 5px 16px; }
@keyframes sk-shimmer { to { background-position: -200% 0; } }
@media (prefers-reduced-motion: reduce) { .sk { animation: none; } }
.recording { align-items: center; gap: 10px; }
.rec-dot { flex: none; width: 10px; height: 10px; border-radius: 50%; background: var(--danger); animation: rec-pulse 1.2s ease-in-out infinite; }
.rec-time { font-variant-numeric: tabular-nums; font-weight: 600; }
.rec-hint { flex: 1; }
@keyframes rec-pulse { 50% { opacity: .3; } }
@media (prefers-reduced-motion: reduce) { .rec-dot { animation: none; } }
.doc { gap: 12px; align-items: center; min-width: min(16rem, 62vw); }
.doc-info { display: grid; min-width: 0; flex: 1; }
.doc-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 14px; font-weight: 600; }
.doc-get {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  min-height: 32px;
  padding: 4px 11px;
  border: 0;
  border-radius: 999px;
  background: color-mix(in srgb, var(--accent) 14%, transparent);
  color: var(--accent);
  font-size: 13px;
  font-weight: 600;
}
.doc-get:hover:not(:disabled) { background: color-mix(in srgb, var(--accent) 22%, transparent); }
.doc-icon {
  display: grid;
  place-items: center;
  flex: none;
  width: 40px;
  height: 40px;
  border-radius: 10px;
  background: color-mix(in srgb, var(--accent) 14%, transparent);
  color: var(--accent);
}
.doc-info { display: flex; flex-direction: column; min-width: 0; }
.doc-name { overflow-wrap: anywhere; }
.progress { font-size: 12px; }
.meter { height: 4px; border-radius: 2px; overflow: hidden; background: var(--border); }
.meter-fill { height: 100%; background: var(--accent); transition: width 0.2s linear; }
</style>
