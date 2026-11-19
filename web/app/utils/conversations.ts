import {
  isIncomingRequest as isIncomingFor,
  listConversationsArgs,
  type Conversation,
  type ListConversationsOptions,
} from '#shared/chat-core'

export { CONVERSATION_PAGE_SIZE, SEND_ERRORS, appendConversations, cacheableConversations, formatTime, peerLabel } from '#shared/chat-core'
export type { Conversation, FoundUser, SendResult } from '#shared/chat-core'

export const listConversations = (options?: ListConversationsOptions) =>
  rpc<Conversation[]>('seru24_list_conversations', listConversationsArgs(options))

/** Permintaan chat dari orang lain yang belum diterima. */
export const isIncomingRequest = (c: Conversation) => isIncomingFor(c, account.me?.id)
