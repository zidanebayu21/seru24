// Cuplikan pesan terakhir untuk daftar chat. Hanya di memori: sumbernya cache lokal (terenkripsi), pesan realtime yang
// masuk, atau satu pesan terakhir dari server; semuanya didekripsi di HP.

import type { ChatMessage } from '../../../web/shared/e2ee-core';
import type { Conversation } from '../../../web/shared/chat-core';
import { deletedPreview, isFreshPreview, previewText, type Preview } from '../../../web/shared/preview-core';
import { loadLocalConversationState } from './chatStorage';
import { account, e2ee, onBeforeSignOut, rpc } from './core';

const cache = new Map<string, Preview>();
/** Hanya percakapan teratas yang dicuplik agar daftar panjang tidak memicu banyak panggilan jaringan. */
const MAX_PREVIEWS = 15;
const BATCH = 4;

export const getPreview = (conversationId: string): Preview | undefined => cache.get(conversationId);

export const clearPreviews = () => cache.clear();

// cuplikan berisi teks pesan: dibuang saat keluar akun
onBeforeSignOut(async () => clearPreviews());

const fromMessage = async (message: ChatMessage, peerId: string): Promise<Preview | null> => {
  if (message.deleted_at) return deletedPreview(message.created_at);
  const text = await e2ee.decryptText(message, peerId);
  if (!text) return null;
  const mine = message.sender_id === account.me?.id;
  const shown = previewText(text, mine);
  return shown ? { text: shown, mine, at: message.created_at } : null;
};

/** Pesan realtime (baru atau diedit/dihapus) langsung menjadi cuplikan tanpa membuka chat. Mengembalikan true bila berubah. */
export const previewFromEvent = async (payload: Record<string, unknown>, peerId: string): Promise<boolean> => {
  const message = payload as unknown as ChatMessage;
  if (!message.conversation_id || !message.created_at) return false;
  const current = cache.get(message.conversation_id);
  // pembaruan untuk pesan lama (bukan yang terakhir) tidak mengubah cuplikan
  if (current && new Date(message.created_at).getTime() < new Date(current.at).getTime()) return false;
  const next = await fromMessage(message, peerId);
  if (!next) return false;
  cache.set(message.conversation_id, next);
  return true;
};

const newestOf = (messages: ChatMessage[]) => messages.reduce<ChatMessage | null>((best, m) => (!best || m.seq > best.seq ? m : best), null);

const loadOne = async (conversation: Conversation, myId: string): Promise<boolean> => {
  const local = await loadLocalConversationState(myId, conversation.id).catch(() => null);
  let latest = local ? newestOf(local.messages) : null;
  const wanted = conversation.last_message_at ? new Date(conversation.last_message_at).getTime() : 0;
  if (!latest || new Date(latest.created_at).getTime() < wanted) {
    const rows = await rpc<ChatMessage[]>('seru24_get_messages', { p_conversation_id: conversation.id, p_limit: 1 }).catch(() => []);
    latest = newestOf(rows ?? []) ?? latest;
  }
  if (!latest) return false;
  const preview = await fromMessage(latest, conversation.peer_id);
  if (!preview) return false;
  cache.set(conversation.id, preview);
  return true;
};

/** Lengkapi cuplikan yang belum ada atau sudah basi; onChange dipanggil bila ada yang baru. */
export const refreshPreviews = async (list: Conversation[], onChange: () => void): Promise<void> => {
  const myId = account.me?.id;
  if (!myId) return;
  const todo = list
    .filter(c => c.last_message_at && c.status !== 'pending' && !isFreshPreview(cache.get(c.id), c.last_message_at))
    .slice(0, MAX_PREVIEWS);
  for (let i = 0; i < todo.length; i += BATCH) {
    const results = await Promise.all(todo.slice(i, i + BATCH).map(c => loadOne(c, myId).catch(() => false)));
    if (results.some(Boolean)) onChange();
  }
};
