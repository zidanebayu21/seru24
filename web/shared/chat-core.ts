// Tipe dan helper percakapan bersama web dan mobile.

export const CHAT_PAGE_SIZE = 50
/** Muat halaman berikutnya saat tersisa ~10 pesan di atas (sekitar 40 pesan di-scroll ke atas dari 50 terbaru). */
export const CHAT_PREFETCH_OFFSET = 10
/** FlatList onEndReachedThreshold memakai satuan tinggi layar (~10 pesan/layar = sekitar 40 dari 50 pesan). */
export const CHAT_MOBILE_PREFETCH_SCREENS = 1

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

export interface PagedBubble {
  key: string
  seq: number
  pending: boolean
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
export const mergePagedBubbles = <T extends PagedBubble>(incoming: readonly T[], current: readonly T[]): T[] => {
  const byKey = new Map<string, T>()
  for (const item of incoming) byKey.set(item.key, item)
  for (const item of current) byKey.set(item.key, item)
  return [...byKey.values()].sort((a, b) => (a.pending ? Infinity : a.seq) - (b.pending ? Infinity : b.seq))
}
