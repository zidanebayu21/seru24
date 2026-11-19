// Mode Dekat: chat langsung antar HP tanpa internet (Bluetooth / Wi-Fi Direct lewat Nearby Connections, Android).
// Yang lewat udara hanya amplop ciphertext E2EE yang sama dengan jalur server; isi pesan tidak pernah terbaca perantara.
// Keaslian pesan dijamin AES-GCM: AAD memuat conversation_id, sender_id, client_msg_id, dan kind, jadi pihak yang
// meniru nama perangkat tidak bisa memalsukan pesan tanpa kunci privat lawan bicara.
// Rujukan: OWASP ASVS V6.2 (algoritma kriptografi), V5.1 (validasi input dari jaringan), V9.1 (komunikasi antar klien).

import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js'
import { MAX_TEXT_LENGTH } from './crypto'
import type { ChatMessage } from './e2ee-core'

/** Batas satu payload Nearby (ConnectionsClient.MAX_BYTES_DATA_SIZE = 32 KB), disisakan untuk pembungkus JSON. */
export const NEARBY_MAX_PAYLOAD_CHARS = 30_000
const MAX_CIPHERTEXT_CHARS = MAX_TEXT_LENGTH * 4 + 256
const MAX_ID_CHARS = 64
const FUTURE_SKEW_MS = 5 * 60_000

/**
 * Nama pendek yang diumumkan ke sekitar. Diturunkan dari id percakapan dan akun sehingga tidak memuat username,
 * dan hanya dua orang di percakapan itu yang bisa mengenalinya.
 */
export const nearbyTag = (conversationId: string, userId: string): string =>
  bytesToHex(sha256(utf8ToBytes(`seru24/nearby/v1:${conversationId}:${userId}`))).slice(0, 16)

export type NearbyWire =
  | { t: 'msg'; m: NearbyMessage }
  | { t: 'ack'; id: string }

/** Bagian ChatMessage yang boleh dikirim; sender_id dan conversation_id sengaja tidak ikut (ditentukan penerima). */
export interface NearbyMessage {
  client_msg_id: string
  ciphertext: string
  nonce: string
  sender_key_version: number
  recipient_key_version: number
  reply_to: string | null
  created_at: string
}

export interface NearbySendParams {
  p_client_msg_id: string
  p_ciphertext: string
  p_nonce: string
  p_sender_key_version: number
  p_recipient_key_version: number
  p_reply_to?: string | null
}

export const encodeNearbyMessage = (params: NearbySendParams, createdAt: string): string =>
  JSON.stringify({
    t: 'msg',
    m: {
      client_msg_id: params.p_client_msg_id,
      ciphertext: params.p_ciphertext,
      nonce: params.p_nonce,
      sender_key_version: params.p_sender_key_version,
      recipient_key_version: params.p_recipient_key_version,
      reply_to: params.p_reply_to ?? null,
      created_at: createdAt,
    },
  } satisfies NearbyWire)

export const encodeNearbyAck = (clientMsgId: string): string => JSON.stringify({ t: 'ack', id: clientMsgId } satisfies NearbyWire)

const isShortString = (value: unknown, max = MAX_ID_CHARS): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= max

const isKeyVersion = (value: unknown): value is number => Number.isInteger(value) && (value as number) >= 1 && (value as number) <= 1_000_000

/** Baca dan validasi ketat data dari jaringan; null bila bentuknya tidak sah (data tidak dipercaya sebelum didekripsi). */
export const parseNearbyWire = (raw: string): NearbyWire | null => {
  if (raw.length > NEARBY_MAX_PAYLOAD_CHARS + 2_000) return null
  let data: unknown
  try {
    data = JSON.parse(raw)
  } catch {
    return null
  }
  if (typeof data !== 'object' || data === null) return null
  const wire = data as { t?: unknown; id?: unknown; m?: Record<string, unknown> }
  if (wire.t === 'ack') return isShortString(wire.id) ? { t: 'ack', id: wire.id } : null
  if (wire.t !== 'msg' || typeof wire.m !== 'object' || wire.m === null) return null
  const m = wire.m
  const replyOk = m.reply_to === null || m.reply_to === undefined || isShortString(m.reply_to)
  if (
    !isShortString(m.client_msg_id) ||
    !isShortString(m.ciphertext, MAX_CIPHERTEXT_CHARS) ||
    !isShortString(m.nonce, 64) ||
    !isKeyVersion(m.sender_key_version) ||
    !isKeyVersion(m.recipient_key_version) ||
    !replyOk ||
    !isShortString(m.created_at, 40)
  ) {
    return null
  }
  return {
    t: 'msg',
    m: {
      client_msg_id: m.client_msg_id,
      ciphertext: m.ciphertext,
      nonce: m.nonce,
      sender_key_version: m.sender_key_version,
      recipient_key_version: m.recipient_key_version,
      reply_to: (m.reply_to as string | null | undefined) ?? null,
      created_at: m.created_at,
    },
  }
}

/** Waktu dari pengirim dibatasi tidak melewati jam penerima, supaya pesan tidak bisa "dari masa depan". */
export const clampCreatedAt = (value: string, now = Date.now()): string => {
  const time = Date.parse(value)
  return Number.isNaN(time) || time > now + FUTURE_SKEW_MS ? new Date(now).toISOString() : new Date(time).toISOString()
}

/**
 * Pesan dari lawan bicara dalam bentuk ChatMessage (seq 0 = belum ada di server). Id percakapan dan pengirim
 * ditentukan dari sisi penerima, bukan dari isi payload; pemalsuan akan gagal saat didekripsi.
 */
export const nearbyAsMessage = (m: NearbyMessage, conversationId: string, peerId: string, now = Date.now()): ChatMessage => ({
  id: m.client_msg_id,
  conversation_id: conversationId,
  sender_id: peerId,
  seq: 0,
  client_msg_id: m.client_msg_id,
  kind: 'text',
  ciphertext: m.ciphertext,
  nonce: m.nonce,
  sender_key_version: m.sender_key_version,
  recipient_key_version: m.recipient_key_version,
  reply_to: m.reply_to,
  created_at: clampCreatedAt(m.created_at, now),
  edited_at: null,
  deleted_at: null,
  expires_at: null,
})

/** Simpan paling banyak segini pesan diterima langsung yang belum muncul dari server. */
export const NEARBY_INBOX_LIMIT = 200

/** Tambah pesan ke kotak masuk lokal tanpa duplikat; yang tertua dibuang bila melebihi batas. */
export const addToNearbyInbox = (inbox: readonly ChatMessage[], message: ChatMessage): ChatMessage[] =>
  inbox.some((item) => item.client_msg_id === message.client_msg_id)
    ? [...inbox]
    : [...inbox, message].slice(-NEARBY_INBOX_LIMIT)
