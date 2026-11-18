// Status online dan "sedang mengetik…" lawan bicara, bersama web dan mobile.
// Lewat Realtime presence + broadcast di channel privat "conv:<id>" (policy realtime.messages: hanya anggota);
// tanpa tabel, tanpa isi pesan. "Online" = lawan sedang membuka percakapan ini.

import type { RealtimeChannel, SupabaseClient } from '@supabase/supabase-js'

/** Sinyal mengetik dikirim paling sering sekali per 3 detik agar hemat kuota pesan Realtime. */
export const TYPING_SEND_INTERVAL_MS = 3000
/** Tanda "sedang mengetik…" hilang sendiri bila tidak ada sinyal baru. */
export const TYPING_VISIBLE_MS = 5000

export interface PeerPresence {
  online: boolean
  typing: boolean
}

export const createConversationPresence = (
  client: SupabaseClient,
  conversationId: string,
  myId: string,
  onChange: (state: PeerPresence) => void,
) => {
  let state: PeerPresence = { online: false, typing: false }
  let typingTimer: ReturnType<typeof setTimeout> | undefined
  let lastSent = 0

  const emit = (patch: Partial<PeerPresence>) => {
    state = { ...state, ...patch }
    onChange(state)
  }

  const channel: RealtimeChannel = client.channel(`conv:${conversationId}`, {
    config: { private: true, presence: { key: myId } },
  })
  channel.on('presence', { event: 'sync' }, () => {
    emit({ online: Object.keys(channel.presenceState()).some((key) => key !== myId) })
  })
  channel.on('broadcast', { event: 'typing' }, ({ payload }) => {
    if ((payload as { user_id?: string } | undefined)?.user_id === myId) return
    clearTimeout(typingTimer)
    emit({ typing: true })
    typingTimer = setTimeout(() => emit({ typing: false }), TYPING_VISIBLE_MS)
  })
  channel.subscribe((status) => {
    if (status === 'SUBSCRIBED') channel.track({ at: Date.now() }).catch(() => undefined)
  })

  /** Panggil saat pengguna mengetik; pengiriman dibatasi TYPING_SEND_INTERVAL_MS. */
  const notifyTyping = () => {
    const now = Date.now()
    if (now - lastSent < TYPING_SEND_INTERVAL_MS) return
    lastSent = now
    channel.send({ type: 'broadcast', event: 'typing', payload: { user_id: myId } }).catch(() => undefined)
  }

  /** Pesan baru dari lawan masuk: tanda mengetik dihapus. */
  const clearPeerTyping = () => {
    clearTimeout(typingTimer)
    if (state.typing) emit({ typing: false })
  }

  const close = () => {
    clearTimeout(typingTimer)
    client.removeChannel(channel).catch(() => undefined)
  }

  return { notifyTyping, clearPeerTyping, close }
}
