import { bytesToHex, randomBytes } from '@noble/hashes/utils.js';
import type { ChatMessage } from '../../../web/shared/e2ee-core';
import {
  buildEndpointName,
  contactTag,
  encodeNearbyAck,
  encodeNearbyHello,
  encodeNearbyMessage,
  matchContact,
  nearbyAsMessage,
  parseEndpointName,
  parseNearbyWire,
  randomAlias,
  shouldInitiate,
  strangerConversationId,
  type KnownContact,
  type NearbyHello,
  type NearbySendParams,
} from '../../../web/shared/nearby-core';
import { account, e2ee, whenAccountReady } from './core';
import { loadLocalConversations } from './chatStorage';
import {
  acceptNearby,
  disconnectNearby,
  nearbySupported,
  onNearbyEvent,
  rejectNearby,
  requestNearby,
  saveNearbyReceived,
  sendNearby,
  startNearby,
  stopNearby,
  type NearbyEvent,
} from './nearby';
import { addStrangerMessage, loadStrangers, markStrangerAcked, syncStrangers, upsertStranger, type StrangerMessage } from './strangers';

// Siaran Dekat (radar): HP mengumumkan alias acak, lalu menemukan HP lain. Sesama kontak (dikenali dari tag, lalu
// dicocokkan dengan kunci yang sudah dikenal) tersambung otomatis. Orang asing hanya tersambung bila kita yang
// menghubungi, atau kita menerima permintaannya; username dan kunci baru dikirim lewat saluran terenkripsi setelah itu.

export type PeerPhase = 'found' | 'requesting' | 'connected' | 'incoming' | 'ready';

export interface PeerIdentity {
  userId: string;
  username: string;
  keyVersion: number;
  publicKey: string;
}

export interface RadarPeer {
  endpointId: string;
  alias: string;
  sessionId: string;
  phase: PeerPhase;
  /** Kita yang memulai koneksi. */
  initiator: boolean;
  /** Kontak yang diharapkan (dari tag) atau terbukti (dari handshake). */
  contact: KnownContact | null;
  /** Identitas lawan setelah handshake; kontak dengan kunci cocok = trusted. */
  identity?: PeerIdentity;
  trusted: boolean;
  /** Kode keamanan untuk dicocokkan lisan (orang asing). */
  code?: string;
}

export type RadarMessageEvent =
  | { kind: 'contact'; conversationId: string; message: ChatMessage }
  | { kind: 'stranger'; userId: string };

const ACCEPT_WINDOW_MS = 20_000;
const STRANGER_WAIT_MS = 120_000;
const MAX_BAD_PAYLOADS = 3;

let active = false;
let sessionId = '';
let contacts: KnownContact[] = [];
let lastWarning = '';
let lastError = '';
const peers = new Map<string, RadarPeer>();
const timers = new Map<string, ReturnType<typeof setTimeout>>();
const badPayloads = new Map<string, number>();
const changeListeners = new Set<() => void>();
const messageListeners = new Set<(event: RadarMessageEvent) => void>();
const ackListeners = new Set<(clientMsgId: string) => void>();
let unsubscribe: (() => void) | null = null;

const notifyChange = () => {
  for (const listener of changeListeners) listener();
};

export const radarSupported = nearbySupported;
export const isRadarOn = () => active;
export const getRadarPeers = (): RadarPeer[] => [...peers.values()];
export const getRadarWarning = () => lastWarning;
/** Penyebab kegagalan menyalakan siaran terakhir (dari Google Play Services), untuk ditampilkan ke pengguna. */
export const getRadarError = () => lastError;
export const onRadarChange = (listener: () => void) => {
  changeListeners.add(listener);
  return () => {
    changeListeners.delete(listener);
  };
};
export const onRadarMessage = (listener: (event: RadarMessageEvent) => void) => {
  messageListeners.add(listener);
  return () => {
    messageListeners.delete(listener);
  };
};
export const onRadarAck = (listener: (clientMsgId: string) => void) => {
  ackListeners.add(listener);
  return () => {
    ackListeners.delete(listener);
  };
};

/** Lawan yang sudah selesai handshake menurut id akunnya (bukan endpoint), atau undefined. */
export const readyPeerFor = (userId: string): RadarPeer | undefined =>
  getRadarPeers().find(p => p.phase === 'ready' && p.identity?.userId === userId);

const myId = () => account.me?.id ?? '';
const override = (identity: PeerIdentity) => ({ key_version: identity.keyVersion, public_key: identity.publicKey, revoked: false });

const clearTimer = (endpointId: string) => {
  clearTimeout(timers.get(endpointId));
  timers.delete(endpointId);
};

const drop = (endpointId: string, disconnect: boolean) => {
  clearTimer(endpointId);
  badPayloads.delete(endpointId);
  if (disconnect) disconnectNearby(endpointId);
  if (peers.delete(endpointId)) notifyChange();
};

/** Tanpa handshake selesai dalam batas waktu, sambungan dilepas (mencegah perangkat asing menahan koneksi). */
const expireIn = (endpointId: string, ms: number) => {
  clearTimer(endpointId);
  timers.set(endpointId, setTimeout(() => {
    const peer = peers.get(endpointId);
    if (peer && peer.phase !== 'ready' && peer.phase !== 'incoming') drop(endpointId, true);
  }, ms));
};

const sendHello = async (endpointId: string) => {
  const mine = e2ee.myPublicKey();
  const me = account.me;
  if (!mine || !me) return false;
  const hello: NearbyHello = { u: mine.user_id, n: me.username, k: mine.key_version, pk: mine.public_key };
  return sendNearby(endpointId, encodeNearbyHello(hello)).then(() => true, () => false);
};

const refreshContacts = async () => {
  const list = await loadLocalConversations(myId()).catch(() => []);
  contacts = list.filter(c => !c.peer_blocked).map(c => ({ conversationId: c.id, peerId: c.peer_id }));
};

/** Sambung otomatis hanya ke kontak (tag cocok) dan hanya dari satu sisi; orang asing menunggu pilihan pengguna. */
const onFound = (event: NearbyEvent) => {
  const name = parseEndpointName(event.value);
  if (!name || peers.has(event.id)) return;
  const contact = matchContact(name.tags, contacts);
  peers.set(event.id, { endpointId: event.id, alias: name.alias, sessionId: name.id, phase: 'found', initiator: false, contact, trusted: false });
  notifyChange();
  if (contact && shouldInitiate(sessionId, name.id)) void connectTo(event.id);
};

export const connectTo = async (endpointId: string) => {
  const peer = peers.get(endpointId);
  if (!active || !peer || peer.phase !== 'found') return;
  peer.phase = 'requesting';
  peer.initiator = true;
  notifyChange();
  expireIn(endpointId, peer.contact ? ACCEPT_WINDOW_MS : STRANGER_WAIT_MS);
  try {
    await requestNearby(endpointId);
  } catch {
    peer.phase = 'found';
    peer.initiator = false;
    clearTimer(endpointId);
    notifyChange();
  }
};

const onIncoming = (event: NearbyEvent) => {
  const existing = peers.get(event.id);
  if (existing?.initiator) {
    acceptNearby(event.id); // koneksi yang kita minta sendiri
    return;
  }
  const name = parseEndpointName(event.value.split('\n')[0] ?? '');
  if (!name) {
    rejectNearby(event.id);
    return;
  }
  const contact = matchContact(name.tags, contacts);
  peers.set(event.id, {
    endpointId: event.id, alias: name.alias, sessionId: name.id, phase: 'connected', initiator: false, contact, trusted: false,
  });
  acceptNearby(event.id); // hanya saluran; identitas kita belum dikirim sampai pengguna menerima
  expireIn(event.id, ACCEPT_WINDOW_MS);
  notifyChange();
};

const onConnected = async (event: NearbyEvent) => {
  const peer = peers.get(event.id);
  if (!peer) return;
  if (peer.initiator) {
    peer.phase = 'connected';
    await sendHello(event.id);
    expireIn(event.id, peer.contact ? ACCEPT_WINDOW_MS : STRANGER_WAIT_MS);
    notifyChange();
  }
};

const becomeReady = async (peer: RadarPeer) => {
  peer.phase = 'ready';
  clearTimer(peer.endpointId);
  if (peer.identity && !peer.trusted) await upsertStranger(peer.identity);
  notifyChange();
  if (peer.identity) void flushUnacked(peer);
};

const handleHello = async (peer: RadarPeer, h: NearbyHello) => {
  if (peer.identity || h.u === myId()) {
    if (h.u === myId()) drop(peer.endpointId, true);
    return;
  }
  const identity: PeerIdentity = { userId: h.u, username: h.n, keyVersion: h.k, publicKey: h.pk };
  const known = contacts.find(c => c.peerId === h.u) ?? null;
  // kontak yang diharapkan dari tag harus orang yang sama dengan yang memperkenalkan diri
  if (peer.contact && peer.contact.peerId !== h.u) {
    drop(peer.endpointId, true);
    return;
  }
  const check = known ? await e2ee.checkClaimedKey(h.u, override(identity)) : 'unknown';
  if (check === 'mismatch') {
    lastWarning = `Kunci @${h.n} berbeda dari yang tersimpan. Sambungan ditolak.`;
    drop(peer.endpointId, true);
    return;
  }
  peer.identity = identity;
  peer.contact = known;
  peer.trusted = check === 'match';
  peer.code = e2ee.claimedSafetyCode(override(identity)) ?? undefined;

  if (peer.initiator) {
    await becomeReady(peer); // lawan membalas hello = menerima
  } else if (peer.trusted) {
    if (await sendHello(peer.endpointId)) await becomeReady(peer);
  } else {
    peer.phase = 'incoming';
    clearTimer(peer.endpointId);
    notifyChange();
  }
};

/** Terima permintaan orang asing: kirim identitas kita dan mulai obrolan. */
export const acceptIncoming = async (endpointId: string) => {
  const peer = peers.get(endpointId);
  if (!peer || peer.phase !== 'incoming') return;
  if (await sendHello(endpointId)) await becomeReady(peer);
  else drop(endpointId, true);
};

export const rejectIncoming = (endpointId: string) => drop(endpointId, true);

const emitMessage = (event: RadarMessageEvent) => {
  for (const listener of messageListeners) listener(event);
};

const handleMessage = async (peer: RadarPeer, wire: Extract<ReturnType<typeof parseNearbyWire>, { t: 'msg' }>) => {
  const identity = peer.identity;
  if (peer.phase !== 'ready' || !identity) return;
  const trustedContact = peer.trusted && peer.contact;
  const conversationId = trustedContact ? peer.contact!.conversationId : strangerConversationId(myId(), identity.userId);
  const message = nearbyAsMessage(wire.m, conversationId, identity.userId);
  // gagal dibuka = bukan dari lawan bicara ini atau data diubah (AES-GCM): dibuang tanpa ack
  const text = await e2ee.decryptText(message, identity.userId, trustedContact ? undefined : override(identity));
  if (text === null) return;
  await sendNearby(peer.endpointId, encodeNearbyAck(message.client_msg_id)).catch(() => undefined);
  if (trustedContact) {
    await saveNearbyReceived(message);
    emitMessage({ kind: 'contact', conversationId, message });
    return;
  }
  const record: StrangerMessage = { id: message.client_msg_id, mine: false, text, createdAt: message.created_at, acked: true, synced: false };
  await addStrangerMessage(identity.userId, record);
  emitMessage({ kind: 'stranger', userId: identity.userId });
};

const onPayload = async (event: NearbyEvent) => {
  const peer = peers.get(event.id);
  if (!peer) return;
  const wire = parseNearbyWire(event.value);
  if (!wire) {
    const count = (badPayloads.get(event.id) ?? 0) + 1;
    badPayloads.set(event.id, count);
    if (count >= MAX_BAD_PAYLOADS) drop(event.id, true);
    return;
  }
  if (wire.t === 'hello') await handleHello(peer, wire.h);
  else if (wire.t === 'msg') await handleMessage(peer, wire);
  else {
    await markStrangerAcked(wire.id);
    for (const listener of ackListeners) listener(wire.id);
  }
};

const handleEvent = (event: NearbyEvent) => {
  if (!active && event.type !== 'state') return;
  const run = async () => {
    switch (event.type) {
      case 'found': onFound(event); break;
      case 'lost': if (peers.get(event.id)?.phase === 'found') drop(event.id, false); break;
      case 'incoming': onIncoming(event); break;
      case 'connected': await onConnected(event); break;
      case 'failed': {
        const peer = peers.get(event.id);
        // permintaan ditolak atau gagal: kembali ke daftar (bila masih terlihat) agar bisa dicoba lagi
        if (peer?.initiator) {
          peer.phase = 'found';
          peer.initiator = false;
          peer.identity = undefined;
          clearTimer(event.id);
          notifyChange();
        } else drop(event.id, false);
        break;
      }
      case 'disconnected': drop(event.id, false); break;
      case 'payload': await onPayload(event); break;
      case 'state': if (event.value === 'error' || event.value === 'off') { active = false; peers.clear(); notifyChange(); } break;
    }
  };
  run().catch(() => undefined);
};

/** Nyalakan siaran. Izin runtime diminta lebih dulu oleh pemanggil (requestNearbyPermissions). */
export const startRadar = async (): Promise<boolean> => {
  lastError = '';
  if (!nearbySupported) {
    lastError = 'perangkat tidak mendukung';
    return false;
  }
  // tepat setelah aplikasi dibuka, kunci chat masih dipulihkan di belakang
  await whenAccountReady();
  if (!account.me?.id || !e2ee.myPublicKey()) {
    lastError = 'kunci chat belum siap, coba lagi sebentar';
    return false;
  }
  await refreshContacts();
  sessionId = bytesToHex(randomBytes(4));
  const tags = contacts.map(c => contactTag(c.conversationId, myId()));
  const name = buildEndpointName({ alias: randomAlias(randomBytes(2)), id: sessionId, tags });
  unsubscribe ??= onNearbyEvent(handleEvent);
  active = true;
  lastWarning = '';
  try {
    await startNearby(name);
  } catch (error) {
    active = false;
    lastError = error instanceof Error ? error.message : String(error);
    notifyChange();
    return false;
  }
  notifyChange();
  return true;
};

export const stopRadar = async () => {
  active = false;
  for (const id of [...timers.keys()]) clearTimer(id);
  peers.clear();
  badPayloads.clear();
  await stopNearby();
  notifyChange();
  syncStrangers().catch(() => undefined);
};

/** Kirim amplop pesan kontak ke HP lawan yang sedang tersambung; false bila tidak tersambung. */
export const sendContactMessage = async (userId: string, params: NearbySendParams, createdAt: string): Promise<boolean> => {
  const peer = readyPeerFor(userId);
  if (!peer || !peer.trusted) return false;
  return sendNearby(peer.endpointId, encodeNearbyMessage(params, createdAt)).then(() => true, () => false);
};

/** Kirim pesan teks ke orang asing yang sedang tersambung; selalu disimpan di HP untuk disinkronkan nanti. */
export const sendStrangerText = async (userId: string, text: string): Promise<StrangerMessage> => {
  const peer = readyPeerFor(userId);
  const session = (await loadStrangers()).find(s => s.userId === userId);
  if (!session) throw new Error('Obrolan tidak ditemukan');
  const params = await e2ee.encryptText(strangerConversationId(myId(), userId), userId, text, false, {
    peerKey: override({ userId, username: session.username, keyVersion: session.keyVersion, publicKey: session.publicKey }),
  });
  const record: StrangerMessage = { id: params.p_client_msg_id, mine: true, text, createdAt: new Date().toISOString(), acked: false, synced: false };
  await addStrangerMessage(userId, record);
  if (peer) await sendNearby(peer.endpointId, encodeNearbyMessage(params, record.createdAt)).catch(() => undefined);
  return record;
};

/** Baru tersambung kembali: kirim ulang pesan kita yang belum dikonfirmasi (disegel ulang, id sama; penerima membuang duplikat). */
const flushUnacked = async (peer: RadarPeer) => {
  const identity = peer.identity;
  if (!identity || peer.trusted) return;
  const session = (await loadStrangers()).find(s => s.userId === identity.userId);
  for (const message of session?.messages.filter(m => m.mine && !m.acked) ?? []) {
    const params = await e2ee.encryptText(strangerConversationId(myId(), identity.userId), identity.userId, message.text, false, {
      clientMsgId: message.id,
      peerKey: override(identity),
    }).catch(() => null);
    if (params) await sendNearby(peer.endpointId, encodeNearbyMessage(params, message.createdAt)).catch(() => undefined);
  }
};
