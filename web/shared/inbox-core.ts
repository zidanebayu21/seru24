// Realtime pesan masuk bersama web dan mobile: satu channel privat per pengguna ("user:<id>"),
// otorisasi lewat policy di realtime.messages.

import type { RealtimeChannel, SupabaseClient } from '@supabase/supabase-js'

export type InboxEvent = 'message_new' | 'message_update' | 'read'
export type InboxHandler = (event: InboxEvent, payload: Record<string, unknown>) => void

const EVENTS: InboxEvent[] = ['message_new', 'message_update', 'read']

export const createInbox = (getClient: () => SupabaseClient, getUserId: () => string | undefined) => {
  const handlers = new Set<InboxHandler>()
  let channel: RealtimeChannel | null = null

  const ensureChannel = () => {
    const userId = getUserId()
    if (channel || !userId) return
    channel = getClient().channel(`user:${userId}`, { config: { private: true } })
    for (const event of EVENTS) {
      channel.on('broadcast', { event }, ({ payload }) => {
        for (const handler of handlers) handler(event, payload)
      })
    }
    channel.subscribe()
  }

  /** Daftarkan handler; kembalikan fungsi untuk berhenti mendengar. */
  const onInbox = (handler: InboxHandler) => {
    handlers.add(handler)
    ensureChannel()
    return () => {
      handlers.delete(handler)
    }
  }

  const closeInbox = () => {
    handlers.clear()
    if (channel) {
      getClient().removeChannel(channel)
      channel = null
    }
  }

  return { onInbox, closeInbox }
}
