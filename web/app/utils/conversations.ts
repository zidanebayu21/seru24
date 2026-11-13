import { isIncomingRequest as isIncomingFor, type Conversation } from '#shared/chat-core'

export { SEND_ERRORS, formatTime, peerLabel } from '#shared/chat-core'
export type { Conversation, FoundUser, SendResult } from '#shared/chat-core'

export const listConversations = () => rpc<Conversation[]>('seru24_list_conversations')

/** Permintaan chat dari orang lain yang belum diterima. */
export const isIncomingRequest = (c: Conversation) => isIncomingFor(c, account.me?.id)
