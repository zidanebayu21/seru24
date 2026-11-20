// Tipe dan helper percakapan bersama web dan mobile.

export const CHAT_PAGE_SIZE = 50
/** Muat halaman berikutnya saat tersisa ~10 pesan di atas (sekitar 40 pesan di-scroll ke atas dari 50 terbaru). */
export const CHAT_PREFETCH_OFFSET = 10
/** FlatList onEndReachedThreshold memakai satuan tinggi layar (~10 pesan/layar = sekitar 40 dari 50 pesan). */
export const CHAT_MOBILE_PREFETCH_SCREENS = 1

/** Jumlah percakapan per halaman di daftar chat. */
export const CONVERSATION_PAGE_SIZE = 50

export interface ListConversationsOptions {
  limit?: number
  offset?: number
  /** Ambil satu percakapan saja (mis. saat membuka chat yang tidak ada di halaman yang sudah dimuat). */
  id?: string
}

/** Argumen RPC seru24_list_conversations; kunci yang kosong tidak dikirim. */
export const listConversationsArgs = (options: ListConversationsOptions = {}): Record<string, unknown> => ({
  ...(options.limit === undefined ? {} : { p_limit: options.limit }),
  ...(options.offset === undefined ? {} : { p_offset: options.offset }),
  ...(options.id === undefined ? {} : { p_id: options.id }),
})

/** Tambahkan halaman berikutnya tanpa duplikat (percakapan bisa bergeser antar-halaman saat ada pesan baru). */
export const appendConversations = (current: Conversation[], page: Conversation[]): Conversation[] => {
  const known = new Set(current.map((conversation) => conversation.id))
  return [...current, ...page.filter((conversation) => !known.has(conversation.id))]
}

/**
 * Isi cache lokal: bila daftar baru hanya sebagian (masih ada halaman lain), percakapan lama yang belum
 * dimuat dipertahankan; bila lengkap, daftar baru menggantikan cache (percakapan yang sudah hilang ikut hilang).
 */
export const cacheableConversations = (fresh: Conversation[], cached: Conversation[], hasMore: boolean): Conversation[] =>
  hasMore ? appendConversations(fresh, cached) : fresh

export interface Conversation {
  id: string
  status: 'pending' | 'accepted'
  requested_by: string | null
  last_message_at: string | null
  unread: number
  muted: boolean
  archived: boolean
  pinned: boolean
  peer_id: string
  peer_username: string
  peer_display_name: string
  peer_blocked: boolean
}

export interface FoundUser {
  id: string
  username: string
  display_name: string
}

export interface SendResult {
  ok: boolean
  code?: string
  id?: string
  seq?: number
  created_at?: string
}

/** Kode penolakan seru24_send_message -> pesan untuk pengguna. */
export const SEND_ERRORS: Record<string, string> = {
  device_not_registered: 'Perangkat belum terdaftar. Buka ulang aplikasi.',
  not_member: 'Percakapan tidak ditemukan.',
  unavailable: 'Pesan tidak dapat dikirim.',
  stale_key: 'Kunci lawan bicara berubah. Coba kirim lagi.',
  rate_limited: 'Terlalu banyak pesan. Tunggu sebentar.',
  unsupported_kind: 'Jenis pesan belum didukung.',
}

export const peerLabel = (c: Pick<Conversation, 'peer_display_name' | 'peer_username'>) =>
  c.peer_display_name || `@${c.peer_username}`

/** Permintaan chat dari orang lain yang belum diterima. */
export const isIncomingRequest = (c: Conversation, myId: string | undefined) =>
  c.status === 'pending' && c.requested_by !== myId

export const formatTime = (iso: string | null) => {
  if (!iso) return ''
  const date = new Date(iso)
  const sameDay = date.toDateString() === new Date().toDateString()
  return sameDay
    ? date.toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' })
    : date.toLocaleDateString('id-ID', { day: 'numeric', month: 'short' })
}

/** Jam saja (mis. 14.05), untuk gelembung yang tanggalnya sudah ada di pemisah hari. */
export const formatClock = (iso: string | null) =>
  iso ? new Date(iso).toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' }) : ''

/** Label pemisah hari: Hari ini, Kemarin, atau tanggal (dengan tahun bila bukan tahun ini). */
export const formatDayLabel = (iso: string, now: Date = new Date()): string => {
  const date = new Date(iso)
  const days = Math.round((startOfDay(now) - startOfDay(date)) / 86_400_000)
  if (days === 0) return 'Hari ini'
  if (days === 1) return 'Kemarin'
  return date.toLocaleDateString('id-ID', {
    day: 'numeric',
    month: 'long',
    ...(date.getFullYear() === now.getFullYear() ? {} : { year: 'numeric' }),
  })
}

const startOfDay = (date: Date) => new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime()

export const isSameDay = (a: string, b: string) => new Date(a).toDateString() === new Date(b).toDateString()

/**
 * Pesan hasil ambil ulang yang belum ada di cache, atau yang sudah dihapus/diedit sejak itu. Dipakai saat
 * kembali aktif: siaran realtime yang terlewat (app di latar belakang) tidak mengubah pesan lama sendiri.
 */
export const changedMessages = <T extends { client_msg_id: string; deleted_at?: string | null; edited_at?: string | null }>(
  known: T[],
  fetched: T[],
): T[] => {
  const byId = new Map(known.map((message) => [message.client_msg_id, message]))
  return fetched.filter((message) => {
    const existing = byId.get(message.client_msg_id)
    return !existing || (existing.deleted_at ?? null) !== (message.deleted_at ?? null) || (existing.edited_at ?? null) !== (message.edited_at ?? null)
  })
}

export interface PagedBubble {
  key: string
  seq: number
  pending: boolean
  /** Waktu pesan; dipakai mengurutkan sesama pesan yang belum punya seq (antrean, Siaran Dekat). */
  createdAt?: string
}

/** seq terkecil dari pesan yang sudah tersimpan di server (untuk p_before_seq paginasi). */
export const oldestPersistedSeq = (items: readonly PagedBubble[]): number | null => {
  let min: number | null = null
  for (const item of items) {
    if (!item.pending && item.seq > 0 && (min === null || item.seq < min)) min = item.seq
  }
  return min
}

/** Gabungkan halaman pesan lama ke daftar yang sudah ada tanpa duplikat key, tetap urut naik. */
/**
 * Urutan tampil: pesan tersimpan menurut seq; yang belum tersimpan (mengirim/gagal, seq 0) selalu paling bawah dan
 * sesamanya menurut waktu, supaya pesan yang diterima langsung (Siaran Dekat) tidak naik di atas pesan yang lebih lama.
 */
export const compareBubbles = (a: PagedBubble, b: PagedBubble): number => {
  const rank = (x: PagedBubble) => (x.pending || x.seq <= 0 ? Infinity : x.seq)
  if (rank(a) !== rank(b)) return rank(a) - rank(b)
  return rank(a) === Infinity ? (a.createdAt ?? '').localeCompare(b.createdAt ?? '') : 0
}

export const mergePagedBubbles = <T extends PagedBubble>(incoming: readonly T[], current: readonly T[]): T[] => {
  const byKey = new Map<string, T>()
  for (const item of incoming) byKey.set(item.key, item)
  for (const item of current) byKey.set(item.key, item)
  return [...byKey.values()].sort(compareBubbles)
}

export interface CacheableMessage {
  client_msg_id: string
  seq: number
  deleted_at?: string | null
  edited_at?: string | null
}

/** Gabungkan pesan dari cache IndexedDB dan server sambil mengabaikan pesan yang sudah dihapus lokal. */
export const mergeCachedMessages = <T extends CacheableMessage>(
  cached: readonly T[],
  incoming: readonly T[],
  deletedClientMsgIds?: ReadonlySet<string>,
  clearedUpToSeq = 0,
): T[] => {
  const byId = new Map<string, T>()
  const keep = (item: T) =>
    !(deletedClientMsgIds?.has(item.client_msg_id)) && item.seq > clearedUpToSeq

  for (const item of cached) {
    if (keep(item)) byId.set(item.client_msg_id, item)
  }
  for (const item of incoming) {
    if (keep(item)) byId.set(item.client_msg_id, item)
  }
  return [...byId.values()].sort((a, b) => a.seq - b.seq)
}

/** Salinan pesan yang ditandai terhapus di server, sama seperti hasil seru24_delete_message (isi dikosongkan). */
export const markMessageDeleted = <T extends CacheableMessage & { ciphertext: string | null; nonce: string | null }>(
  message: T,
  deletedAt = new Date().toISOString(),
): T => ({ ...message, ciphertext: null, nonce: null, deleted_at: deletedAt })

/** Ambil satu halaman pesan (urut naik) dari kumpulan pesan lokal. */
export const sliceMessagesPage = <T extends { seq: number }>(
  messages: readonly T[],
  beforeSeq?: number | null,
  limit = CHAT_PAGE_SIZE,
): { rows: T[]; hasOlder: boolean } => {
  const safeLimit = Math.max(1, limit)
  const filtered = beforeSeq != null ? messages.filter((m) => m.seq < beforeSeq) : [...messages]
  filtered.sort((a, b) => a.seq - b.seq)
  if (filtered.length <= safeLimit) {
    return { rows: filtered, hasOlder: false }
  }
  return {
    rows: filtered.slice(filtered.length - safeLimit),
    hasOlder: true,
  }
}

export interface StatusBubble {
  pending: boolean
  failed: string
  mine: boolean
  seq: number
  createdAt: string
}

/** Status di bawah gelembung: jam, lalu ✓ (terkirim ke server) atau ✓✓ (sudah dibaca lawan) untuk pesan sendiri. */
export const bubbleStatus = (b: StatusBubble, peerReadSeq: number): { text: string; ticks: '' | '✓' | '✓✓'; read: boolean } => {
  if (b.pending) return { text: 'mengirim…', ticks: '', read: false }
  if (b.failed) return { text: b.failed, ticks: '', read: false }
  const text = formatTime(b.createdAt)
  if (!b.mine) return { text, ticks: '', read: false }
  const read = b.seq > 0 && b.seq <= peerReadSeq
  return { text, ticks: read ? '✓✓' : '✓', read }
}

export const REPLY_SNIPPET_LENGTH = 80

/** Cuplikan pesan yang dibalas (teks sudah didekripsi di perangkat; server hanya menyimpan reply_to). */
export const replySnippet = (target: { text: string | null; deleted: boolean } | null | undefined): string => {
  if (!target) return 'Pesan sebelumnya'
  if (target.deleted) return 'Pesan dihapus'
  if (target.text === null) return 'Pesan tidak dapat dibuka'
  const text = target.text.replace(/\s+/g, ' ').trim()
  return text.length > REPLY_SNIPPET_LENGTH ? `${text.slice(0, REPLY_SNIPPET_LENGTH)}…` : text
}
