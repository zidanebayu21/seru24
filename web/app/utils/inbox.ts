import { createInbox } from '#shared/inbox-core'

export type { InboxEvent, InboxHandler } from '#shared/inbox-core'

// Logika realtime bersama web dan mobile ada di shared/inbox-core.ts.
const core = createInbox(() => useSupabase(), () => account.me?.id)

export const onInbox = core.onInbox
export const closeInbox = core.closeInbox
