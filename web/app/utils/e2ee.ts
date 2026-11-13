import { x25519 } from '@noble/curves/ed25519.js'
import {
  MAX_TEXT_LENGTH,
  decryptMessage,
  deriveConversationKey,
  encryptMessage,
  fromBase64,
  randomId,
  safetyCode,
  type MessageKind,
} from '#shared/crypto'

export interface ChatMessage {
  id: string
  conversation_id: string
  sender_id: string | null
  seq: number
  client_msg_id: string
  kind: MessageKind
  ciphertext: string | null
  nonce: string | null
  sender_key_version: number
  recipient_key_version: number
  reply_to: string | null
  created_at: string
  edited_at: string | null
  deleted_at: string | null
  expires_at: string | null
}

interface PublicKeyRow {
  key_version: number
  public_key: string
  revoked: boolean
}

export type PeerKeyStatus = { status: 'missing' } | { status: 'ok' | 'changed'; code: string }

const publicKeys = new Map<string, PublicKeyRow[]>()
const conversationKeys = new Map<string, Uint8Array>()

export const resetE2ee = () => {
  publicKeys.clear()
  for (const key of conversationKeys.values()) key.fill(0)
  conversationKeys.clear()
}

const fetchPublicKeys = async (userId: string, force = false) => {
  if (force || !publicKeys.has(userId)) {
    publicKeys.set(userId, await rpc<PublicKeyRow[]>('seru24_get_public_keys', { p_user: userId }))
  }
  return publicKeys.get(userId)!
}

const latestKey = (rows: PublicKeyRow[]) => rows.filter((r) => !r.revoked).at(-1)

const findKey = async (userId: string, version: number) =>
  (await fetchPublicKeys(userId)).find((r) => r.key_version === version)
  ?? (await fetchPublicKeys(userId, true)).find((r) => r.key_version === version)

const conversationKey = async (conversationId: string, peerId: string, myVersion: number, peerVersion: number) => {
  const cacheKey = `${conversationId}|${myVersion}|${peerVersion}`
  const cached = conversationKeys.get(cacheKey)
  if (cached) return cached

  const secret = getKeyring()?.[String(myVersion)]
  const peerKey = await findKey(peerId, peerVersion)
  if (!secret || !peerKey || !account.me) throw new Error('Kunci tidak tersedia')

  const key = deriveConversationKey(secret, fromBase64(peerKey.public_key), conversationId,
    { userId: account.me.id, keyVersion: myVersion }, { userId: peerId, keyVersion: peerVersion })
  conversationKeys.set(cacheKey, key)
  return key
}

/** Parameter siap kirim ke RPC seru24_send_message. */
export const encryptText = async (conversationId: string, peerId: string, text: string, refreshPeer = false) => {
  const me = account.me
  if (!me?.key_version) throw new Error('Kunci belum siap')
  if (text.length > MAX_TEXT_LENGTH) throw new Error(`Maksimal ${MAX_TEXT_LENGTH} karakter`)
  const peer = latestKey(await fetchPublicKeys(peerId, refreshPeer))
  if (!peer) throw new Error('Lawan bicara belum menyiapkan kunci enkripsi')

  const clientMsgId = randomId()
  const key = await conversationKey(conversationId, peerId, me.key_version, peer.key_version)
  const sealed = encryptMessage(key, { t: text }, { conversationId, senderId: me.id, clientMsgId, kind: 'text' })
  return {
    p_conversation_id: conversationId,
    p_client_msg_id: clientMsgId,
    p_kind: 'text',
    p_ciphertext: sealed.ciphertext,
    p_nonce: sealed.nonce,
    p_sender_key_version: me.key_version,
    p_recipient_key_version: peer.key_version,
  }
}

/** null = dihapus, kedaluwarsa, atau gagal dibuka (kunci salah / data diubah). */
export const decryptText = async (message: ChatMessage, peerId: string): Promise<string | null> => {
  if (message.deleted_at || !message.ciphertext || !message.nonce || !account.me) return null
  const mine = message.sender_id === account.me.id
  const myVersion = mine ? message.sender_key_version : message.recipient_key_version
  const peerVersion = mine ? message.recipient_key_version : message.sender_key_version
  try {
    const key = await conversationKey(message.conversation_id, peerId, myVersion, peerVersion)
    const body = decryptMessage<{ t?: unknown }>(
      key,
      { ciphertext: message.ciphertext, nonce: message.nonce },
      { conversationId: message.conversation_id, senderId: message.sender_id ?? '', clientMsgId: message.client_msg_id, kind: message.kind },
    )
    return typeof body.t === 'string' ? body.t.slice(0, MAX_TEXT_LENGTH) : null
  } catch {
    return null
  }
}

const tofuKey = (peerId: string) => `seru24:tofu:${account.me?.id}:${peerId}`

/**
 * Trust on first use: kunci publik lawan disimpan saat pertama dilihat.
 * Bila kemudian berbeda, pengguna diperingatkan (kemungkinan kunci ditukar).
 */
export const checkPeerKey = async (peerId: string): Promise<PeerKeyStatus> => {
  const peer = latestKey(await fetchPublicKeys(peerId, true))
  const mySecret = getKeyring()?.[String(account.me?.key_version)]
  if (!peer || !mySecret) return { status: 'missing' }

  let known: string | null = null
  try {
    known = localStorage.getItem(tofuKey(peerId))
    if (!known) localStorage.setItem(tofuKey(peerId), peer.public_key)
  } catch {
    known = null
  }
  const code = safetyCode(x25519.getPublicKey(mySecret), fromBase64(peer.public_key))
  return { status: known && known !== peer.public_key ? 'changed' : 'ok', code }
}

export const acceptPeerKey = async (peerId: string) => {
  const peer = latestKey(await fetchPublicKeys(peerId, true))
  if (peer) localStorage.setItem(tofuKey(peerId), peer.public_key)
}
