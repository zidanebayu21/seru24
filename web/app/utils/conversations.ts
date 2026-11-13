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

export const listConversations = () => rpc<Conversation[]>('seru24_list_conversations')

export const peerLabel = (c: Pick<Conversation, 'peer_display_name' | 'peer_username'>) =>
  c.peer_display_name || `@${c.peer_username}`

/** Permintaan chat dari orang lain yang belum diterima. */
export const isIncomingRequest = (c: Conversation) =>
  c.status === 'pending' && c.requested_by !== account.me?.id

export const formatTime = (iso: string | null) => {
  if (!iso) return ''
  const date = new Date(iso)
  const sameDay = date.toDateString() === new Date().toDateString()
  return sameDay
    ? date.toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' })
    : date.toLocaleDateString('id-ID', { day: 'numeric', month: 'short' })
}
