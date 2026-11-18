// Enkripsi/dekripsi pesan bersama web dan mobile, di atas shared/crypto.ts.

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
  type SecretKeyring,
} from './crypto'
import type { Me, Rpc } from './account-core'
import { parseFileBody, type FileMessageBody } from './file-core'

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

/** Penyimpanan kunci publik lawan yang pernah dilihat (trust on first use). */
export interface TofuStore {
  get: (key: string) => Promise<string | null>
  set: (key: string, value: string) => Promise<void>
}

export interface E2eeDeps {
  rpc: Rpc
  getKeyring: () => SecretKeyring | null
  getMe: () => Me | null
  tofu: TofuStore
  /** Opsional: simpan kunci publik lawan di perangkat agar pesan tetap terbaca/terkirim saat offline. */
  publicKeyCache?: TofuStore
}

export const createE2ee = (deps: E2eeDeps) => {
  const publicKeys = new Map<string, PublicKeyRow[]>()
  const conversationKeys = new Map<string, Uint8Array>()

  const resetE2ee = () => {
    publicKeys.clear()
    for (const key of conversationKeys.values()) key.fill(0)
    conversationKeys.clear()
  }

  const fetchPublicKeys = async (userId: string, force = false) => {
    if (force || !publicKeys.has(userId)) {
      try {
        const rows = await deps.rpc<PublicKeyRow[]>('seru24_get_public_keys', { p_user: userId })
        publicKeys.set(userId, rows)
        deps.publicKeyCache?.set(userId, JSON.stringify(rows)).catch(() => undefined)
      } catch (error) {
        // offline: pakai kunci publik yang pernah disimpan (kunci publik, bukan rahasia)
        const cached = await deps.publicKeyCache?.get(userId).catch(() => null)
        if (!cached) throw error
        publicKeys.set(userId, JSON.parse(cached) as PublicKeyRow[])
      }
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

    const me = deps.getMe()
    const secret = deps.getKeyring()?.[String(myVersion)]
    const peerKey = await findKey(peerId, peerVersion)
    if (!secret || !peerKey || !me) throw new Error('Kunci tidak tersedia')

    const key = deriveConversationKey(secret, fromBase64(peerKey.public_key), conversationId,
      { userId: me.id, keyVersion: myVersion }, { userId: peerId, keyVersion: peerVersion })
    conversationKeys.set(cacheKey, key)
    return key
  }

  const seal = async (conversationId: string, peerId: string, kind: MessageKind, body: unknown, refreshPeer: boolean) => {
    const me = deps.getMe()
    if (!me?.key_version) throw new Error('Kunci belum siap')
    const peer = latestKey(await fetchPublicKeys(peerId, refreshPeer))
    if (!peer) throw new Error('Lawan bicara belum menyiapkan kunci enkripsi')

    const clientMsgId = randomId()
    const key = await conversationKey(conversationId, peerId, me.key_version, peer.key_version)
    const sealed = encryptMessage(key, body, { conversationId, senderId: me.id, clientMsgId, kind })
    return {
      p_conversation_id: conversationId,
      p_client_msg_id: clientMsgId,
      p_kind: kind,
      p_ciphertext: sealed.ciphertext,
      p_nonce: sealed.nonce,
      p_sender_key_version: me.key_version,
      p_recipient_key_version: peer.key_version,
    }
  }

  /** Parameter siap kirim ke RPC seru24_send_message. */
  const encryptText = async (conversationId: string, peerId: string, text: string, refreshPeer = false) => {
    if (text.length > MAX_TEXT_LENGTH) throw new Error(`Maksimal ${MAX_TEXT_LENGTH} karakter`)
    return seal(conversationId, peerId, 'text', { t: text }, refreshPeer)
  }

  /** Pesan dokumen: metadata dan kunci file ikut terenkripsi E2EE; server hanya melihat attachment_id. */
  const encryptFile = async (conversationId: string, peerId: string, file: FileMessageBody, refreshPeer = false) => ({
    ...(await seal(conversationId, peerId, 'file', { f: file }, refreshPeer)),
    p_attachment_id: file.id,
  })

  /** Isi pesan yang sudah dibuka; null = dihapus, kedaluwarsa, atau gagal dibuka (kunci salah / data diubah). */
  const openBody = async (message: ChatMessage, peerId: string): Promise<{ t?: unknown; f?: unknown } | null> => {
    const me = deps.getMe()
    if (message.deleted_at || !message.ciphertext || !message.nonce || !me) return null
    const mine = message.sender_id === me.id
    const myVersion = mine ? message.sender_key_version : message.recipient_key_version
    const peerVersion = mine ? message.recipient_key_version : message.sender_key_version
    try {
      const key = await conversationKey(message.conversation_id, peerId, myVersion, peerVersion)
      return decryptMessage<{ t?: unknown; f?: unknown }>(
        key,
        { ciphertext: message.ciphertext, nonce: message.nonce },
        { conversationId: message.conversation_id, senderId: message.sender_id ?? '', clientMsgId: message.client_msg_id, kind: message.kind },
      )
    } catch {
      return null
    }
  }

  /** Teks pesan; pesan dokumen tampil sebagai "📎 nama" untuk klien yang belum bisa membuka dokumen. */
  const decryptText = async (message: ChatMessage, peerId: string): Promise<string | null> => {
    const body = await openBody(message, peerId)
    if (typeof body?.t === 'string') return body.t.slice(0, MAX_TEXT_LENGTH)
    const file = parseFileBody(body?.f)
    return file ? `📎 ${file.name}` : null
  }

  const decryptFile = async (message: ChatMessage, peerId: string): Promise<FileMessageBody | null> =>
    message.kind === 'file' ? parseFileBody((await openBody(message, peerId))?.f) : null

  const tofuKey = (peerId: string) => `seru24:tofu:${deps.getMe()?.id}:${peerId}`

  /**
   * Trust on first use: kunci publik lawan disimpan saat pertama dilihat.
   * Bila kemudian berbeda, pengguna diperingatkan (kemungkinan kunci ditukar).
   */
  const checkPeerKey = async (peerId: string): Promise<PeerKeyStatus> => {
    const peer = latestKey(await fetchPublicKeys(peerId, true))
    const mySecret = deps.getKeyring()?.[String(deps.getMe()?.key_version)]
    if (!peer || !mySecret) return { status: 'missing' }

    const known = await deps.tofu.get(tofuKey(peerId)).catch(() => null)
    if (!known) await deps.tofu.set(tofuKey(peerId), peer.public_key).catch(() => undefined)
    const code = safetyCode(x25519.getPublicKey(mySecret), fromBase64(peer.public_key))
    return { status: known && known !== peer.public_key ? 'changed' : 'ok', code }
  }

  const acceptPeerKey = async (peerId: string) => {
    const peer = latestKey(await fetchPublicKeys(peerId, true))
    if (peer) await deps.tofu.set(tofuKey(peerId), peer.public_key)
  }

  return { resetE2ee, encryptText, encryptFile, decryptText, decryptFile, checkPeerKey, acceptPeerKey }
}
