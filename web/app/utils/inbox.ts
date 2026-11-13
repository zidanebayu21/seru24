import type { RealtimeChannel } from '@supabase/supabase-js'

// Satu channel privat per pengguna ("user:<id>"); otorisasi lewat policy di realtime.messages.

export type InboxEvent = 'message_new' | 'message_update' | 'read'
export type InboxHandler = (event: InboxEvent, payload: Record<string, unknown>) => void

const EVENTS: InboxEvent[] = ['message_new', 'message_update', 'read']
const handlers = new Set<InboxHandler>()
let channel: RealtimeChannel | null = null

const ensureChannel = () => {
  if (channel || !account.me) return
  channel = useSupabase().channel(`user:${account.me.id}`, { config: { private: true } })
  for (const event of EVENTS) {
    channel.on('broadcast', { event }, ({ payload }) => {
      for (const handler of handlers) handler(event, payload)
    })
  }
  channel.subscribe()
}

/** Daftarkan handler; kembalikan fungsi untuk berhenti mendengar. */
export const onInbox = (handler: InboxHandler) => {
  handlers.add(handler)
  ensureChannel()
  return () => handlers.delete(handler)
}

export const closeInbox = () => {
  handlers.clear()
  if (channel) {
    useSupabase().removeChannel(channel)
    channel = null
  }
}
