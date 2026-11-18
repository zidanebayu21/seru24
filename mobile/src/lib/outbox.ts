import type { SendResult } from '../../../web/shared/chat-core';
import { account, readSetting, rpc, writeSetting } from './core';

// Antrean pesan teks yang diketik saat offline. Yang disimpan (Keystore HP) hanya parameter RPC yang sudah
// terenkripsi E2EE, bukan teks asli. Dikirim ulang dengan client_msg_id yang sama, jadi aman dari pesan ganda.

export interface QueuedMessage {
  conversationId: string;
  params: {
    p_conversation_id: string;
    p_client_msg_id: string;
    p_kind: string;
    p_ciphertext: string;
    p_nonce: string;
    p_sender_key_version: number;
    p_recipient_key_version: number;
    p_reply_to?: string | null;
  };
  queuedAt: string;
}

type SentListener = (item: QueuedMessage, result: SendResult) => void;

const listeners = new Set<SentListener>();
let flushing: Promise<void> | null = null;
let retryTimer: ReturnType<typeof setTimeout> | undefined;
const RETRY_MS = 15_000;

const storageKey = () => `outbox.${account.me?.id ?? ''}`;

const load = async (): Promise<QueuedMessage[]> => {
  if (!account.me?.id) return [];
  try {
    return JSON.parse((await readSetting(storageKey())) ?? '[]') as QueuedMessage[];
  } catch {
    return [];
  }
};

const save = (items: QueuedMessage[]) => writeSetting(storageKey(), JSON.stringify(items));

export const queueMessage = async (item: QueuedMessage) => {
  const items = await load();
  if (!items.some(x => x.params.p_client_msg_id === item.params.p_client_msg_id)) await save([...items, item]);
  scheduleRetry();
};

export const queuedFor = async (conversationId: string) =>
  (await load()).filter(item => item.conversationId === conversationId);

/** Dipanggil saat pesan antrean terkirim (atau ditolak server): layar chat memperbarui gelembungnya. */
export const onQueuedSent = (listener: SentListener) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

/** Coba kirim lagi beberapa detik kemudian selama masih ada antrean (sinyal bisa kembali kapan saja). */
const scheduleRetry = () => {
  clearTimeout(retryTimer);
  retryTimer = setTimeout(() => {
    flushOutbox().catch(() => undefined);
  }, RETRY_MS);
};

/** Kirim semua antrean berurutan; berhenti di gangguan jaringan pertama (dicoba lagi nanti). */
export const flushOutbox = (): Promise<void> => {
  flushing ??= (async () => {
    let items = await load();
    while (items.length > 0) {
      const [item] = items;
      let result: SendResult;
      try {
        result = await rpc<SendResult>('seru24_send_message', item!.params);
      } catch {
        // gangguan jaringan, atau sesi belum pulih setelah lama offline: pesan tetap di antrean dan dicoba lagi.
        // Hanya penolakan eksplisit server (result.ok = false) yang membuang pesan.
        scheduleRetry();
        return;
      }
      items = items.slice(1);
      await save(items);
      for (const listener of listeners) listener(item!, result);
    }
  })().finally(() => {
    flushing = null;
  });
  return flushing;
};
