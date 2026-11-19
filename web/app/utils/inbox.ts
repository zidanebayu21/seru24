import { createInbox } from '#shared/inbox-core'

export type { InboxEvent, InboxHandler } from '#shared/inbox-core'

// Logika realtime bersama web dan mobile ada di shared/inbox-core.ts.
const core = createInbox(() => useSupabase(), () => account.me?.id)

/** Saluran realtime dibuka setelah library Supabase selesai dimuat; fungsi hasilnya tetap sinkron untuk berhenti. */
export const onInbox: typeof core.onInbox = (handler) => {
  let stopped = false
  let stop: () => void = () => undefined
  ensureSupabase().then(() => {
    if (!stopped) stop = core.onInbox(handler)
  }, () => undefined)
  return () => {
    stopped = true
    stop()
  }
}
export const closeInbox = core.closeInbox
