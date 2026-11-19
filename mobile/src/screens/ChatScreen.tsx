import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Alert, AppState, BackHandler, FlatList, KeyboardAvoidingView, Platform, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { MAX_TEXT_LENGTH, randomId } from '../../../web/shared/crypto';
import {
  createTransferMeter,
  formatClockSeconds,
  formatFileSize,
  isVoiceFile,
  safeFileName,
  splitByFileLimit,
  voiceSecondsFromName,
  type FileMessageBody,
} from '../../../web/shared/file-core';
import { Avatar } from '../components/Avatar';
import { searchMessages } from '../../../web/shared/search-core';
import {
  CHAT_MOBILE_PREFETCH_SCREENS,
  CHAT_PAGE_SIZE,
  SEND_ERRORS,
  bubbleStatus,
  changedMessages,
  formatClock,
  formatTime,
  formatDayLabel,
  isSameDay,
  isIncomingRequest,
  markMessageDeleted,
  mergeCachedMessages,
  mergePagedBubbles,
  oldestPersistedSeq,
  peerLabel,
  replySnippet,
  sliceMessagesPage,
  type Conversation,
  type SendResult,
} from '../../../web/shared/chat-core';
import type { ChatMessage, PeerKeyStatus } from '../../../web/shared/e2ee-core';
import {
  clearLocalConversation,
  loadLocalConversationState,
  saveLocalMessages,
} from '../lib/chatStorage';
import { account, deleteRemoteFile, e2ee, inbox, isOnline, openConversationPresence, rpc, whenAccountReady } from '../lib/core';
import { isNetworkError } from '../../../web/shared/session-core';
import { onQueuedSent, queueMessage, queuedFor, type QueuedMessage } from '../lib/outbox';
import type { PeerPresence } from '../../../web/shared/presence-core';
import { downloadFile, findSavedFile, openSavedFile, pickFiles, uploadFile, type PickedFile } from '../lib/files';
import { notifyMessageSent } from '../lib/notify';
import { onVoiceState, pauseVoice, playVoice, resumeVoice, stopVoice, type VoiceState } from '../lib/audio';
import { Button } from '../components/Button';
import { MenuItem, PopupMenu } from '../components/PopupMenu';
import { colors, themed, ui } from '../theme';

interface Bubble {
  key: string;
  id: string | null;
  seq: number;
  mine: boolean;
  text: string | null;
  createdAt: string;
  deleted: boolean;
  pending: boolean;
  failed: string;
  file: FileMessageBody | null;
  /** Status unggah/unduh dokumen yang sedang berjalan. */
  progress: string;
  /** Bar progres 0..1 untuk unggah/unduh dokumen. */
  fraction?: number;
  /** File sudah diunduh ke HP: tombol jadi "Buka" (tanpa unduh ulang). */
  savedUri: string | null;
  /** id pesan yang dibalas (kolom reply_to). */
  replyTo: string | null;
}

type SendParams = Awaited<ReturnType<typeof e2ee.encryptText>> & { p_attachment_id?: string; p_reply_to?: string | null };

const SAVED_NOTE = 'Tersimpan di Download/seru24';
const QUEUED_NOTE = 'Menunggu sinyal, terkirim otomatis saat online';

/** Pesan antrean dalam bentuk ChatMessage agar bisa didekripsi dan ditampilkan seperti pesan lain. */
const queuedAsMessage = (item: QueuedMessage, myId: string | null): ChatMessage => ({
  id: item.params.p_client_msg_id,
  conversation_id: item.conversationId,
  sender_id: myId,
  seq: 0,
  client_msg_id: item.params.p_client_msg_id,
  kind: item.params.p_kind as ChatMessage['kind'],
  ciphertext: item.params.p_ciphertext,
  nonce: item.params.p_nonce,
  sender_key_version: item.params.p_sender_key_version,
  recipient_key_version: item.params.p_recipient_key_version,
  reply_to: item.params.p_reply_to ?? null,
  created_at: item.queuedAt,
  edited_at: null,
  deleted_at: null,
  expires_at: null,
});


interface Props {
  conversation: Conversation;
  onBack: () => void;
}

export const ChatScreen = ({ conversation: initial, onBack }: Props) => {
  const [conversation, setConversation] = useState(initial);
  const [bubbles, setBubbles] = useState<Bubble[]>([]);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [keyStatus, setKeyStatus] = useState<PeerKeyStatus>({ status: 'missing' });
  const [peerReadSeq, setPeerReadSeq] = useState(0);
  const [replyingTo, setReplyingTo] = useState<Bubble | null>(null);
  const [peerPresence, setPeerPresence] = useState<PeerPresence>({ online: false, typing: false });
  const presenceRef = useRef<ReturnType<typeof openConversationPresence>>(null);
  const [draft, setDraft] = useState('');
  const [error, setError] = useState('');
  const [menuOpen, setMenuOpen] = useState(false);
  const [actionsFor, setActionsFor] = useState<Bubble | null>(null);

  // cari pesan: hanya di HP (cache lokal yang didekripsi di memori), tidak pernah memanggil server
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchBusy, setSearchBusy] = useState(false);
  const [searchPool, setSearchPool] = useState<Bubble[]>([]);
  const [flashKey, setFlashKey] = useState('');
  const searchHits = useMemo(() => (searchOpen ? searchMessages(searchPool, searchQuery) : []), [searchOpen, searchPool, searchQuery]);
  const [voice, setVoice] = useState<VoiceState | null>(null);

  // status pemutar suara dari modul native; hanya satu pesan suara diputar pada satu waktu
  useEffect(() => {
    const stop = onVoiceState(setVoice);
    return () => {
      stop();
      stopVoice();
    };
  }, []);
  // aplikasi baru dibuka: kunci chat masih dipulihkan di belakang
  const [preparing, setPreparing] = useState(account.status !== 'ready');
  const listRef = useRef<FlatList<Bubble>>(null);
  const bubblesRef = useRef<Bubble[]>([]);
  const allMessagesRef = useRef<ChatMessage[]>([]);
  const deletedIdsRef = useRef<Set<string>>(new Set());
  const clearedUpToSeqRef = useRef(0);
  const serverExhaustedRef = useRef(false);
  const hasOlderRef = useRef(false);
  const loadingOlderRef = useRef(false);
  const peerId = conversation.peer_id;

  const updateBubbles = useCallback((updater: (prev: Bubble[]) => Bubble[]) => {
    setBubbles(prev => {
      const next = updater(prev);
      bubblesRef.current = next;
      return next;
    });
  }, []);

  const fileState = useCallback(async (m: ChatMessage) => {
    const file = await e2ee.decryptFile(m, peerId);
    const savedUri = file ? await findSavedFile(file.id) : null;
    return { file, savedUri, progress: savedUri ? SAVED_NOTE : '' };
  }, [peerId]);

  const toBubble = useCallback(async (m: ChatMessage): Promise<Bubble> => ({
    key: m.client_msg_id,
    id: m.id,
    seq: m.seq,
    mine: m.sender_id === account.me?.id,
    text: await e2ee.decryptText(m, peerId),
    createdAt: m.created_at,
    deleted: Boolean(m.deleted_at),
    pending: false,
    failed: '',
    ...(await fileState(m)),
    replyTo: m.reply_to,
  }), [peerId, fileState]);

  const markRead = useCallback((seq: number) => {
    if (seq > 0) rpc('seru24_mark_read', { p_conversation_id: conversation.id, p_seq: seq }).catch(() => undefined);
  }, [conversation.id]);

  useEffect(() => {
    const back = BackHandler.addEventListener('hardwareBackPress', () => {
      onBack();
      return true;
    });
    return () => back.remove();
  }, [onBack]);

  useEffect(() => {
    let alive = true;
    void (async () => {
      const myId = account.me?.id ?? '';
      try {
        const localState = myId
          ? await loadLocalConversationState(myId, conversation.id)
          : { messages: [], deletedIds: new Set<string>(), clearedUpToSeq: 0 };
        if (!alive) return;
        deletedIdsRef.current = localState.deletedIds;
        clearedUpToSeqRef.current = localState.clearedUpToSeq;
        allMessagesRef.current = localState.messages;

        // pesan hanya bisa didekripsi setelah kunci chat dari Keystore siap
        const ready = await whenAccountReady();
        if (!alive) return;
        setPreparing(false);
        if (ready !== 'ready' && ready !== 'offline') return;
        if (ready === 'ready') {
          presenceRef.current = openConversationPresence(conversation.id, setPeerPresence);
          // centang dua tetap benar setelah chat dibuka ulang
          rpc<number>('seru24_peer_read_seq', { p_conversation_id: conversation.id })
            .then(seq => setPeerReadSeq(prev => Math.max(prev, Number(seq) || 0)))
            .catch(() => undefined);
        }

        // offline: kunci publik lawan dari cache HP
        setKeyStatus(await e2ee.checkPeerKey(peerId).catch(() => ({ status: 'missing' as const })));

        if (allMessagesRef.current.length > 0) {
          const initialSlice = sliceMessagesPage(allMessagesRef.current, null, CHAT_PAGE_SIZE);
          const cachedList = await Promise.all(initialSlice.rows.map(toBubble));
          if (!alive) return;
          hasOlderRef.current = initialSlice.hasOlder;
          updateBubbles(() => cachedList);
        }
        await showQueued();

        try {
          const rows = await rpc<ChatMessage[]>('seru24_get_messages', {
            p_conversation_id: conversation.id,
            p_limit: CHAT_PAGE_SIZE,
          });
          if (!alive) return;
          serverExhaustedRef.current = rows.length < CHAT_PAGE_SIZE;
          const merged = mergeCachedMessages(
            allMessagesRef.current,
            rows,
            deletedIdsRef.current,
            clearedUpToSeqRef.current,
          );
          allMessagesRef.current = merged;
          if (myId && rows.length > 0) {
            await saveLocalMessages(myId, conversation.id, rows).catch(() => undefined);
          }
          const latestSlice = sliceMessagesPage(merged, null, CHAT_PAGE_SIZE);
          const list = await Promise.all(latestSlice.rows.map(toBubble));
          if (!alive) return;
          hasOlderRef.current = latestSlice.hasOlder || !serverExhaustedRef.current;
          updateBubbles(() => list);
          markRead(list.at(-1)?.seq ?? 0);
        } catch {
          if (alive && allMessagesRef.current.length === 0) {
            setError('Gagal memuat percakapan');
          }
        }
        await showQueued();
      } catch {
        if (alive) setError('Gagal memuat percakapan');
      }
    })().catch(() => {});

    /** Gabungkan satu pesan (baru, diedit, atau dihapus) ke cache dan daftar gelembung; null bila diabaikan. */
    const applyMessage = async (msg: ChatMessage): Promise<Bubble | null> => {
      if (deletedIdsRef.current.has(msg.client_msg_id) || msg.seq <= clearedUpToSeqRef.current) return null;
      const myId = account.me?.id ?? '';
      allMessagesRef.current = mergeCachedMessages(
        allMessagesRef.current,
        [msg],
        deletedIdsRef.current,
        clearedUpToSeqRef.current,
      );
      if (myId) saveLocalMessages(myId, conversation.id, [msg]).catch(() => undefined);

      const bubble = await toBubble(msg);
      updateBubbles(list => mergePagedBubbles([bubble], list));
      return bubble;
    };

    // Realtime diputus saat app di latar belakang (hemat baterai): saat aktif lagi, ambil pesan terbaru lewat REST
    // dan terapkan yang baru, diedit, atau dihapus selama itu.
    let resyncing = false;
    const resync = async () => {
      if (resyncing) return;
      resyncing = true;
      try {
        const rows = await rpc<ChatMessage[]>('seru24_get_messages', {
          p_conversation_id: conversation.id,
          p_limit: CHAT_PAGE_SIZE,
        });
        const changed = changedMessages(allMessagesRef.current, rows);
        for (const row of changed) {
          if (!alive) return;
          await applyMessage(row);
        }
        const fromPeer = changed.filter(row => row.sender_id !== account.me?.id);
        if (fromPeer.length > 0) markRead(Math.max(...fromPeer.map(row => row.seq)));
        rpc<number>('seru24_peer_read_seq', { p_conversation_id: conversation.id })
          .then(seq => setPeerReadSeq(prev => Math.max(prev, Number(seq) || 0)))
          .catch(() => undefined);
      } catch {
        // tetap tampil dari cache; dicoba lagi saat app aktif berikutnya
      } finally {
        resyncing = false;
      }
    };
    const appState = AppState.addEventListener('change', state => {
      if (state === 'active') resync().catch(() => undefined);
    });

    const stop = inbox.onInbox(async (event, payload) => {
      if (payload.conversation_id !== conversation.id) return;
      if (event === 'read') {
        setPeerReadSeq(seq => Math.max(seq, Number(payload.seq) || 0));
        return;
      }
      const bubble = await applyMessage(payload as unknown as ChatMessage);
      if (!bubble) return;
      if (event === 'message_new') {
        if (!bubble.mine) presenceRef.current?.clearPeerTyping();
        // balasan pertama dari lawan bicara = permintaan chat kita diterima
        setConversation(c => (c.status === 'pending' && payload.sender_id === c.peer_id ? { ...c, status: 'accepted' } : c));
        if (!bubble.mine) markRead(bubble.seq);
      }
    });
    return () => {
      alive = false;
      stop();
      appState.remove();
      presenceRef.current?.close();
      presenceRef.current = null;
    };
  }, [conversation.id, peerId, toBubble, markRead, updateBubbles]);

  useEffect(() => onQueuedSent(async (item, result) => {
    if (item.conversationId !== conversation.id) return;
    // gelembung bisa belum ada bila chat dibuka ulang setelah pesan diantrekan
    const bubble = { ...(await toBubble(queuedAsMessage(item, account.me?.id ?? null))), pending: true };
    updateBubbles(list => (list.some(b => b.key === bubble.key) ? list : [...list, bubble]));
    if (result.ok) markDelivered(item.params, result, false);
    else updateBubble(item.params.p_client_msg_id, { pending: false, progress: '', failed: SEND_ERRORS[result.code ?? ''] ?? 'Pesan gagal dikirim' });
  }));

  const loadOlder = useCallback(async () => {
    if (!hasOlderRef.current || loadingOlderRef.current) return;
    const beforeSeq = oldestPersistedSeq(bubblesRef.current);
    if (beforeSeq === null) {
      hasOlderRef.current = false;
      return;
    }
    loadingOlderRef.current = true;
    setLoadingOlder(true);
    try {
      const myId = account.me?.id ?? '';
      if (!serverExhaustedRef.current) {
        const rows = await rpc<ChatMessage[]>('seru24_get_messages', {
          p_conversation_id: conversation.id,
          p_before_seq: beforeSeq,
          p_limit: CHAT_PAGE_SIZE,
        }).catch(() => null);
        if (rows) {
          if (rows.length < CHAT_PAGE_SIZE) serverExhaustedRef.current = true;
          allMessagesRef.current = mergeCachedMessages(
            allMessagesRef.current,
            rows,
            deletedIdsRef.current,
            clearedUpToSeqRef.current,
          );
          if (myId && rows.length > 0) {
            await saveLocalMessages(myId, conversation.id, rows).catch(() => undefined);
          }
        }
      }

      const page = sliceMessagesPage(allMessagesRef.current, beforeSeq, CHAT_PAGE_SIZE);
      const older = await Promise.all(page.rows.map(toBubble));
      hasOlderRef.current = page.hasOlder || !serverExhaustedRef.current;
      updateBubbles(curr => mergePagedBubbles(older, curr));
    } catch {
      // biarkan pengguna bisa coba scroll lagi saat jaringan pulih
    } finally {
      loadingOlderRef.current = false;
      setLoadingOlder(false);
    }
  }, [conversation.id, toBubble, updateBubbles]);

  const updateBubble = (key: string, patch: Partial<Bubble>) =>
    updateBubbles(list => mergePagedBubbles([], list.map(b => (b.key === key ? { ...b, ...patch } : b))));

  /** Pesan antrean offline (sudah terenkripsi) yang belum terkirim ditampilkan lagi sebagai gelembung "mengirim". */
  const showQueued = async () => {
    const items = await queuedFor(conversation.id);
    if (items.length === 0) return;
    const myId = account.me?.id ?? null;
    const pending = await Promise.all(items.map(async item => ({
      ...(await toBubble(queuedAsMessage(item, myId))),
      pending: true,
      progress: QUEUED_NOTE,
    })));
    updateBubbles(list => [...list.filter(b => !pending.some(p => p.key === b.key)), ...pending]);
  };

  const markDelivered = (params: SendParams | QueuedMessage['params'], result: SendResult, notify: boolean) => {
      const createdAt = result.created_at ?? new Date().toISOString();
      const seq = result.seq ?? 0;
      const myId = account.me?.id ?? '';
      const cachedMsg: ChatMessage = {
        id: result.id ?? params.p_client_msg_id,
        conversation_id: conversation.id,
        sender_id: myId || null,
        seq,
        client_msg_id: params.p_client_msg_id,
        kind: params.p_kind as ChatMessage['kind'],
        ciphertext: params.p_ciphertext,
        nonce: params.p_nonce,
        sender_key_version: params.p_sender_key_version,
        recipient_key_version: params.p_recipient_key_version,
        reply_to: params.p_reply_to ?? null,
        created_at: createdAt,
        edited_at: null,
        deleted_at: null,
        expires_at: null,
      };
      allMessagesRef.current = mergeCachedMessages(
        allMessagesRef.current,
        [cachedMsg],
        deletedIdsRef.current,
        clearedUpToSeqRef.current,
      );
      if (myId) saveLocalMessages(myId, conversation.id, [cachedMsg]).catch(() => undefined);
      updateBubble(params.p_client_msg_id, { id: result.id ?? null, seq, createdAt, pending: false, progress: '' });
      if (notify && result.id && result.code !== 'duplicate') {
        notifyMessageSent(conversation.id, result.id);
      }
  };

  const deliver = async (build: (retry: boolean) => Promise<SendParams>, localKey: string, retry = false): Promise<void> => {
    const params = await build(retry);
    updateBubble(localKey, { key: params.p_client_msg_id });
    let result: SendResult;
    try {
      if (!isOnline()) throw new TypeError('offline');
      result = await rpc<SendResult>('seru24_send_message', params);
    } catch (error) {
      // sinyal hilang: pesan teks (sudah terenkripsi) masuk antrean dan dikirim otomatis saat online
      if (params.p_kind === 'text' && (isNetworkError(error) || !isOnline())) {
        await queueMessage({ conversationId: conversation.id, params, queuedAt: new Date().toISOString() });
        updateBubble(params.p_client_msg_id, { progress: QUEUED_NOTE });
        return;
      }
      throw error;
    }
    if (result.ok) {
      markDelivered(params, result, true);
      return;
    }
    if (result.code === 'stale_key' && !retry) {
      setKeyStatus(await e2ee.checkPeerKey(peerId));
      return deliver(build, params.p_client_msg_id, true);
    }
    updateBubble(params.p_client_msg_id, { pending: false, failed: SEND_ERRORS[result.code ?? ''] ?? 'Pesan gagal dikirim' });
  };

  const send = async () => {
    const text = draft.trim();
    if (!text) return;
    setDraft('');
    setError('');
    const replyTo = replyingTo?.id ?? null;
    setReplyingTo(null);
    const localKey = addLocalBubble(text, replyTo);
    try {
      await deliver(async retry => ({ ...(await e2ee.encryptText(conversation.id, peerId, text, retry)), p_reply_to: replyTo }), localKey);
      if (isIncomingRequest(conversation, account.me?.id)) setConversation(c => ({ ...c, status: 'accepted' }));
    } catch (e) {
      updateBubbles(list => list.map(b => (b.pending && b.text === text ? { ...b, pending: false, failed: e instanceof Error ? e.message : 'Pesan gagal dikirim' } : b)));
    }
  };

  const addLocalBubble = (text: string, replyTo: string | null = null) => {
    const localKey = `local-${randomId()}`;
    updateBubbles(list => [...list, {
      key: localKey, id: null, seq: 0, mine: true, text, createdAt: new Date().toISOString(),
      deleted: false, pending: true, failed: '', file: null, progress: '', savedUri: null, replyTo,
    }]);
    listRef.current?.scrollToOffset({ offset: 0, animated: true });
    return localKey;
  };

  /** Dokumen dikirim satu per satu: enkripsi + unggah per potongan, lalu pesan berisi kunci file (E2EE). */
  const sendFile = async (picked: PickedFile) => {
    let key = addLocalBubble(`📎 ${safeFileName(picked.name)}`);
    let uploaded: FileMessageBody | null = null;
    try {
      updateBubble(key, { progress: 'Mengenkripsi…' });
      const meter = createTransferMeter('Mengunggah');
      uploaded = await uploadFile(conversation.id, picked, (done, total) => {
        const { label, fraction } = meter(done, total);
        updateBubble(key, { progress: label, fraction });
      });
      const meta = uploaded;
      updateBubble(key, { file: meta, progress: '' });
      await deliver(retry => e2ee.encryptFile(conversation.id, peerId, meta, retry).then(params => {
        key = params.p_client_msg_id;
        return params;
      }), key);
    } catch (e) {
      const failed = !isOnline() || isNetworkError(e)
        ? 'Butuh koneksi untuk mengirim dokumen'
        : e instanceof Error && e.message ? e.message : 'Dokumen gagal dikirim';
      updateBubble(key, { pending: false, progress: '', failed });
    }
    // pesan gagal terkirim: jangan tinggalkan file yatim di Drive
    const sent = bubblesRef.current.find(b => b.key === key);
    if (uploaded && (!sent || sent.failed)) deleteRemoteFile(uploaded.id).catch(() => undefined);
  };

  const attachFiles = async () => {
    setError('');
    const picked = await pickFiles().catch(() => [] as PickedFile[]);
    // file di atas batas tidak dibuat sebagai pesan (tidak bisa dihapus dari daftar): cukup popup
    const { allowed, message } = splitByFileLimit(picked);
    if (message) Alert.alert('File terlalu besar', message);
    for (const file of allowed) await sendFile(file);
  };

  /** Sudah tersimpan di HP: langsung buka; bila filenya sudah dihapus dari HP, unduh ulang. */
  const openOrDownload = async (item: Bubble) => {
    if (!item.file) return;
    if (item.savedUri) {
      const still = await findSavedFile(item.file.id);
      if (still) {
        await openSavedFile(still, item.file.mime)
          .catch(() => updateBubble(item.key, { failed: 'Tidak ada aplikasi untuk membuka file ini' }));
        return;
      }
      updateBubble(item.key, { savedUri: null, progress: '' });
    } else if (item.progress) {
      return;
    }
    updateBubble(item.key, { failed: '', progress: 'Mengunduh…' });
    try {
      const meter = createTransferMeter('Mengunduh');
      const uri = await downloadFile(item.file, (done, total) => {
        const { label, fraction } = meter(done, total);
        updateBubble(item.key, { progress: label, fraction });
      });
      updateBubble(item.key, { progress: SAVED_NOTE, savedUri: uri });
    } catch {
      updateBubble(item.key, { progress: '', failed: 'Dokumen gagal diunduh' });
    }
  };

  const accept = async () => {
    if (await rpc<boolean>('seru24_accept_chat', { p_conversation_id: conversation.id }).catch(() => false)) {
      setConversation(c => ({ ...c, status: 'accepted' }));
    }
  };

  const toggleBlock = async () => {
    await rpc(conversation.peer_blocked ? 'seru24_unblock_user' : 'seru24_block_user', { p_target: peerId });
    setConversation(c => ({ ...c, peer_blocked: !c.peer_blocked }));
  };

  const trustNewKey = async () => {
    await e2ee.acceptPeerKey(peerId);
    setKeyStatus(await e2ee.checkPeerKey(peerId));
  };

  const removeMessage = async (item: Bubble) => {
    if (!item.id) return;
    const cached = allMessagesRef.current.find(m => m.client_msg_id === item.key);
    // pesan dokumen: file di Google Drive dihapus permanen lebih dulu
    const file = cached ? await e2ee.decryptFile(cached, peerId) : null;
    if (file) await deleteRemoteFile(file.id).catch(() => undefined);
    if (!(await rpc<boolean>('seru24_delete_message', { p_message_id: item.id }).catch(() => false))) return;
    updateBubble(item.key, { deleted: true, text: null });
    // Samakan cache lokal dengan server agar ciphertext pesan yang dihapus tidak tertinggal di HP.
    const myId = account.me?.id ?? '';
    if (!cached) return;
    const deleted = markMessageDeleted(cached);
    allMessagesRef.current = mergeCachedMessages(allMessagesRef.current, [deleted], deletedIdsRef.current, clearedUpToSeqRef.current);
    if (myId) saveLocalMessages(myId, conversation.id, [deleted]).catch(() => undefined);
  };

  const clearChatLocally = async () => {
    const myId = account.me?.id ?? '';
    const maxSeq = bubblesRef.current.reduce((max, b) => (b.pending ? max : Math.max(max, b.seq)), 0);
    const upTo = Math.max(maxSeq, clearedUpToSeqRef.current);
    if (myId) {
      await clearLocalConversation(myId, conversation.id, upTo).catch(() => undefined);
    }
    clearedUpToSeqRef.current = upTo;
    deletedIdsRef.current.clear();
    allMessagesRef.current = [];
    hasOlderRef.current = false;
    updateBubbles(() => []);
  };

  const closeMenuThen = (action: () => Promise<void>) => {
    setMenuOpen(false);
    action().catch(() => undefined);
  };

  /** Pesan yang dikutip (bila sudah termuat) beserta nama pengirimnya. */
  const quoteOf = (b: Bubble) => {
    const target = b.replyTo ? bubblesRef.current.find(x => x.id === b.replyTo) : undefined;
    return { who: !target ? '' : target.mine ? 'Anda' : peerLabel(conversation), snippet: replySnippet(target) };
  };

  const onDraftChange = (text: string) => {
    setDraft(text);
    if (text) presenceRef.current?.notifyTyping();
  };

  /** Dekripsi seluruh pesan yang tersimpan di HP ini sekali per sesi pencarian (hanya di memori). */
  const openSearch = async () => {
    setSearchOpen(true);
    setSearchBusy(true);
    try {
      const rows = allMessagesRef.current.filter(m => !deletedIdsRef.current.has(m.client_msg_id) && m.seq > clearedUpToSeqRef.current);
      const out: Bubble[] = [];
      for (let i = 0; i < rows.length; i += 200) out.push(...(await Promise.all(rows.slice(i, i + 200).map(toBubble))));
      setSearchPool(out);
    } finally {
      setSearchBusy(false);
    }
  };

  const closeSearch = () => {
    setSearchOpen(false);
    setSearchQuery('');
    setSearchPool([]);
  };

  /** Lompat ke pesan hasil pencarian; bila belum dimuat di layar, muat dari cache lokal sampai pesan itu. */
  const goToMessage = async (key: string) => {
    closeSearch();
    if (!bubblesRef.current.some(b => b.key === key)) {
      const ordered = allMessagesRef.current
        .filter(m => !deletedIdsRef.current.has(m.client_msg_id) && m.seq > clearedUpToSeqRef.current)
        .sort((a, b) => a.seq - b.seq);
      const index = ordered.findIndex(m => m.client_msg_id === key);
      if (index < 0) return;
      const start = Math.max(0, index - 10);
      const loaded = await Promise.all(ordered.slice(start, start + 1000).map(toBubble));
      const pending = bubblesRef.current.filter(b => b.pending);
      hasOlderRef.current = start > 0 || !serverExhaustedRef.current;
      updateBubbles(() => [...loaded, ...pending]);
    }
    setFlashKey(key);
    setTimeout(() => setFlashKey(current => (current === key ? '' : current)), 1800);
    // beri waktu daftar menyusun ulang, lalu gulir ke pesan (inverted: indeks dihitung dari yang terbaru)
    setTimeout(() => {
      const index = [...bubblesRef.current].reverse().findIndex(b => b.key === key);
      if (index >= 0) listRef.current?.scrollToIndex({ index, viewPosition: 0.5, animated: true });
    }, 200);
  };

  /** Hapus pesan bersifat permanen untuk kedua pihak (dokumen ikut dihapus dari server): minta konfirmasi dulu. */
  const confirmRemove = (item: Bubble) => {
    Alert.alert(
      item.file ? 'Hapus dokumen?' : 'Hapus pesan?',
      `${item.file ? 'File juga dihapus permanen dari server. ' : ''}Berlaku untuk kedua pihak dan tidak bisa dibatalkan.`,
      [
        { text: 'Batal', style: 'cancel' },
        { text: 'Hapus', style: 'destructive', onPress: () => void removeMessage(item) },
      ],
    );
  };

  const confirmClearChat = async () => {
    Alert.alert('Hapus riwayat chat?', 'Hanya di HP ini. Pesan di server dan di perangkat lain tidak ikut terhapus.', [
      { text: 'Batal', style: 'cancel' },
      { text: 'Hapus', style: 'destructive', onPress: () => void clearChatLocally() },
    ]);
  };

  /** Putar, jeda, atau lanjutkan pesan suara; memutar yang lain otomatis menghentikan yang sedang berjalan. */
  const toggleVoice = async (item: Bubble) => {
    const file = item.file;
    if (!file) return;
    if (voice?.id === file.id && voice.state === 'playing') return pauseVoice();
    if (voice?.id === file.id && voice.state === 'paused') return resumeVoice();
    setVoice({ id: file.id, state: 'loading', positionMs: 0, durationMs: 0 });
    try {
      await playVoice(file);
    } catch {
      setVoice(null);
      updateBubble(item.key, { failed: 'Pesan suara gagal dimuat' });
    }
  };

  /** Tekan lama pada gelembung: balas, atau hapus (pesan sendiri). */
  const showActions = (item: Bubble) => {
    if (!item.id || item.pending || item.deleted) return;
    setActionsFor(item);
  };

  const subtitle = peerPresence.typing
    ? 'sedang mengetik…'
    : `@${conversation.peer_username} · ${peerPresence.online ? 'online' : 'terenkripsi end-to-end'}`;

  const cannotSend = keyStatus.status === 'missing' || conversation.peer_blocked;
  const reversedBubbles = useMemo(() => [...bubbles].reverse(), [bubbles]);

  return (
    <KeyboardAvoidingView style={ui.screen} behavior={Platform.OS === 'ios' ? 'padding' : 'height'}>
      <View style={styles.header}>
        <Pressable accessibilityRole="button" accessibilityLabel="Kembali" onPress={onBack} hitSlop={8} style={{ paddingHorizontal: 8 }}>
          <Text style={{ fontSize: 34, lineHeight: 36, color: colors.text }}>‹</Text>
        </Pressable>
        <Avatar name={peerLabel(conversation)} seed={conversation.peer_username} size={40} />
        <View style={{ flex: 1, marginLeft: 8 }}>
          <Text numberOfLines={1} style={{ fontWeight: '700', color: colors.text }}>{peerLabel(conversation)}</Text>
          <Text style={[ui.muted, peerPresence.typing ? { color: colors.accent, fontStyle: 'italic' } : null]}>{subtitle}</Text>
        </View>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Cari pesan"
          onPress={() => (searchOpen ? closeSearch() : openSearch())}
          hitSlop={8}
          style={{ paddingHorizontal: 8, paddingVertical: 8 }}>
          <Text style={{ color: colors.accent, fontWeight: '600' }}>Cari</Text>
        </Pressable>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Menu percakapan"
          onPress={() => setMenuOpen(true)}
          hitSlop={8}
          style={{ paddingHorizontal: 12, paddingVertical: 8 }}>
          <Text style={{ fontSize: 22, lineHeight: 22, color: colors.text }}>⋮</Text>
        </Pressable>
      </View>
      {searchOpen ? (
        <View style={styles.searchPanel}>
          <View style={ui.row}>
            <TextInput
              style={[ui.input, { flex: 1 }]}
              value={searchQuery}
              onChangeText={setSearchQuery}
              placeholder="Cari di percakapan ini"
              placeholderTextColor={colors.muted}
              autoFocus
              autoCorrect={false}
              returnKeyType="search"
            />
            <Pressable onPress={closeSearch} accessibilityRole="button" accessibilityLabel="Tutup pencarian" hitSlop={8}>
              <Text style={{ color: colors.accent, fontWeight: '600' }}>Tutup</Text>
            </Pressable>
          </View>
          <Text style={ui.muted}>Pencarian hanya di HP ini; tidak memakai server.</Text>
          {searchBusy ? <Text style={ui.muted}>Menyiapkan pesan…</Text> : null}
          {!searchBusy && searchQuery.trim() && searchHits.length === 0 ? <Text style={ui.muted}>Tidak ada pesan yang cocok.</Text> : null}
          <FlatList
            data={searchHits}
            keyExtractor={hit => hit.key}
            keyboardShouldPersistTaps="handled"
            style={{ maxHeight: 280 }}
            renderItem={({ item: hit }) => (
              <Pressable onPress={() => goToMessage(hit.key)} accessibilityRole="button" style={styles.hit}>
                <Text style={[ui.muted, { width: 56, fontSize: 12 }]}>{formatTime(hit.createdAt)}</Text>
                <Text style={{ flex: 1, color: colors.text, fontSize: 14 }}>
                  {hit.before}
                  <Text style={styles.hitMatch}>{hit.match}</Text>
                  {hit.after}
                </Text>
              </Pressable>
            )}
          />
        </View>
      ) : null}
      <PopupMenu open={menuOpen} onClose={() => setMenuOpen(false)}>
        <MenuItem label="Hapus riwayat chat di HP ini" onPress={() => closeMenuThen(confirmClearChat)} />
        <MenuItem
          label={conversation.peer_blocked ? 'Buka blokir' : 'Blokir'}
          danger={!conversation.peer_blocked}
          onPress={() => closeMenuThen(toggleBlock)}
        />
      </PopupMenu>

      <PopupMenu open={actionsFor !== null} onClose={() => setActionsFor(null)}>
        <MenuItem
          label="Balas"
          onPress={() => {
            const target = actionsFor;
            setActionsFor(null);
            if (target) setReplyingTo(target);
          }}
        />
        {actionsFor?.mine ? (
          <MenuItem
            label="Hapus pesan"
            danger
            onPress={() => {
              const target = actionsFor;
              setActionsFor(null);
              if (target) confirmRemove(target);
            }}
          />
        ) : null}
      </PopupMenu>

      <View style={{ paddingHorizontal: 16, gap: 8 }}>
        {keyStatus.status === 'changed' ? (
          <View style={[ui.notice, { gap: 8 }]}>
            <Text>Kunci enkripsi lawan bicara berubah. Cocokkan kode keamanan: {keyStatus.code}</Text>
            <Button label="Saya sudah cocokkan" variant="plain" onPress={trustNewKey} />
          </View>
        ) : null}
        {keyStatus.status === 'missing' && !preparing ? (
          <Text style={ui.notice}>Lawan bicara belum menyiapkan kunci enkripsi, jadi pesan belum bisa dikirim.</Text>
        ) : null}
        {isIncomingRequest(conversation, account.me?.id) ? (
          <View style={[ui.notice, { gap: 8 }]}>
            <Text>@{conversation.peer_username} ingin mengirim pesan kepada Anda.</Text>
            <View style={ui.row}>
              <Button label="Terima" onPress={accept} />
              <Button label="Blokir" variant="danger" onPress={toggleBlock} />
            </View>
          </View>
        ) : null}
        {error ? <Text style={ui.error}>{error}</Text> : null}
      </View>

      <FlatList
        ref={listRef}
        inverted
        data={reversedBubbles}
        onScrollToIndexFailed={info => {
          // tinggi gelembung belum terukur: gulir kira-kira dulu, lalu coba lagi
          listRef.current?.scrollToOffset({ offset: info.averageItemLength * info.index, animated: false });
          setTimeout(() => listRef.current?.scrollToIndex({ index: info.index, viewPosition: 0.5, animated: true }), 150);
        }}
        keyExtractor={b => b.key}
        contentContainerStyle={styles.listContent}
        onEndReached={loadOlder}
        onEndReachedThreshold={CHAT_MOBILE_PREFETCH_SCREENS}
        ListFooterComponent={
          loadingOlder || preparing ? (
            <View style={styles.olderLoader}>
              <ActivityIndicator size="small" color={colors.accent} />
              <Text style={ui.muted}>{preparing ? 'Membuka kunci chat…' : 'Memuat pesan lama…'}</Text>
            </View>
          ) : null
        }
        renderItem={({ item, index }) => (
          <View>
          {!reversedBubbles[index + 1] || !isSameDay(reversedBubbles[index + 1]!.createdAt, item.createdAt) ? (
            <View style={styles.dayWrap}>
              <Text style={styles.dayChip}>{formatDayLabel(item.createdAt)}</Text>
            </View>
          ) : null}
          <Pressable
            onLongPress={() => showActions(item)}
            delayLongPress={300}
            accessibilityHint="Tekan lama untuk membalas atau menghapus"
            style={[
              styles.bubble,
              item.mine ? styles.mine : styles.theirs,
              item.failed ? { borderColor: colors.danger, borderWidth: 1.5 } : null,
              flashKey === item.key ? { borderColor: colors.accent, borderWidth: 2 } : null,
              reversedBubbles[index + 1] && reversedBubbles[index + 1]!.mine === item.mine && isSameDay(reversedBubbles[index + 1]!.createdAt, item.createdAt)
                ? { marginTop: -3 }
                : null,
            ]}>
            {item.replyTo && !item.deleted ? (
              <View style={styles.quote}>
                {quoteOf(item).who ? <Text style={styles.quoteWho}>{quoteOf(item).who}</Text> : null}
                <Text style={[ui.muted, { fontSize: 12 }]} numberOfLines={2}>{quoteOf(item).snippet}</Text>
              </View>
            ) : null}
            {item.deleted ? (
              <Text style={ui.muted}>Pesan dihapus</Text>
            ) : item.text === null ? (
              <Text style={ui.muted}>Pesan tidak dapat dibuka</Text>
            ) : item.file && isVoiceFile(item.file) ? (
              <View style={styles.voiceRow}>
                <Pressable
                  onPress={() => toggleVoice(item)}
                  disabled={item.pending}
                  accessibilityRole="button"
                  accessibilityLabel={voice?.id === item.file.id && voice.state === 'playing' ? 'Jeda' : 'Putar pesan suara'}
                  style={styles.voiceButton}>
                  <Text style={styles.voiceGlyph}>{voice?.id === item.file.id && voice.state === 'playing' ? '❚❚' : '▶'}</Text>
                </Pressable>
                <View style={styles.voiceTrack}>
                  <View
                    style={[
                      styles.voiceFill,
                      {
                        width: `${voice?.id === item.file.id && voice.durationMs > 0 ? Math.min(100, (voice.positionMs / voice.durationMs) * 100) : 0}%`,
                      },
                    ]}
                  />
                </View>
                <Text style={[ui.muted, { fontSize: 12, minWidth: 40, textAlign: 'right' }]}>
                  {voice?.id === item.file.id && voice.state === 'loading'
                    ? 'Memuat…'
                    : formatClockSeconds(
                        voice?.id === item.file.id && (voice.state === 'playing' || voice.state === 'paused') ? voice.positionMs / 1000 : (voiceSecondsFromName(item.file.name) ?? 0),
                      )}
                </Text>
              </View>
            ) : item.file ? (
              <View style={[ui.row, { gap: 10 }]}>
                <View style={styles.docTile}>
                  <Text style={styles.docExt}>{(item.file.name.split('.').pop() ?? 'FILE').slice(0, 4).toUpperCase()}</Text>
                </View>
                <View style={{ flexShrink: 1 }}>
                  <Text numberOfLines={1} style={{ color: colors.text, fontWeight: '600' }}>{item.file.name}</Text>
                  <Text style={[ui.muted, { fontSize: 12 }]}>{formatFileSize(item.file.size)}</Text>
                </View>
                {!item.pending ? (
                  <Pressable
                    onPress={() => openOrDownload(item)}
                    disabled={Boolean(item.progress) && !item.savedUri}
                    accessibilityRole="button"
                    accessibilityLabel={`${item.savedUri ? 'Buka' : 'Unduh'} ${item.file.name}`}
                    style={styles.docButton}>
                    <Text style={{ color: colors.accent, fontWeight: '600' }}>{item.savedUri ? 'Buka' : 'Unduh'}</Text>
                  </Pressable>
                ) : null}
              </View>
            ) : (
              <Text style={{ color: colors.text }}>{item.text}</Text>
            )}
            {item.progress ? <Text style={[ui.muted, { fontSize: 12 }]}>{item.progress}</Text> : null}
            {item.progress && item.fraction !== undefined ? (
              <View style={[styles.barTrack, { backgroundColor: colors.border }]}>
                <View style={[styles.barFill, { backgroundColor: colors.accent, width: `${Math.round(item.fraction * 100)}%` }]} />
              </View>
            ) : null}
            <View style={[ui.row, { justifyContent: 'flex-end', gap: 10 }]}>
              <Text style={[ui.muted, { fontSize: 11 }]}>{item.pending || item.failed ? bubbleStatus(item, peerReadSeq).text : formatClock(item.createdAt)}</Text>
              {bubbleStatus(item, peerReadSeq).ticks ? (
                <Text
                  accessibilityLabel={bubbleStatus(item, peerReadSeq).read ? 'Dibaca' : 'Terkirim'}
                  style={[styles.ticks, bubbleStatus(item, peerReadSeq).read ? styles.ticksRead : null]}>
                  {bubbleStatus(item, peerReadSeq).ticks}
                </Text>
              ) : null}
            </View>
          </Pressable>
          </View>
        )}
      />

      {replyingTo ? (
        <View style={styles.replying}>
          <View style={[styles.quote, { flex: 1, marginBottom: 0 }]}>
            <Text style={styles.quoteWho}>Membalas {replyingTo.mine ? 'diri sendiri' : peerLabel(conversation)}</Text>
            <Text style={[ui.muted, { fontSize: 12 }]} numberOfLines={2}>{replySnippet(replyingTo)}</Text>
          </View>
          <Pressable onPress={() => setReplyingTo(null)} accessibilityRole="button" accessibilityLabel="Batal membalas" hitSlop={8}>
            <Text style={[ui.muted, { fontSize: 16 }]}>✕</Text>
          </Pressable>
        </View>
      ) : null}
      <View style={styles.composer}>
        <View style={styles.composerPill}>
          <Pressable
            onPress={attachFiles}
            disabled={cannotSend}
            accessibilityRole="button"
            accessibilityLabel="Kirim dokumen (maks 50 MB per file)"
            hitSlop={6}
            style={[styles.roundButton, { opacity: cannotSend ? 0.4 : 1 }]}>
            <Text style={{ fontSize: 26, lineHeight: 28, color: colors.muted }}>+</Text>
          </Pressable>
          <TextInput
            style={styles.composerInput}
            value={draft}
            onChangeText={onDraftChange}
            placeholder="Tulis pesan"
            placeholderTextColor={colors.muted}
            multiline
            editable={!cannotSend}
            maxLength={MAX_TEXT_LENGTH}
          />
          <Pressable
            onPress={send}
            disabled={!draft.trim() || cannotSend}
            accessibilityRole="button"
            accessibilityLabel="Kirim pesan"
            style={[styles.roundButton, styles.sendButton, { opacity: !draft.trim() || cannotSend ? 0.4 : 1 }]}>
            <Text style={{ fontSize: 20, lineHeight: 22, color: colors.accentText, fontWeight: '700' }}>↑</Text>
          </Pressable>
        </View>
      </View>
    </KeyboardAvoidingView>
  );
};

const styles = themed(() => ({
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 8,
    paddingVertical: 8,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
    backgroundColor: colors.surface,
  },
  bubble: { maxWidth: '82%', paddingVertical: 8, paddingHorizontal: 12, borderRadius: 18, gap: 2 },
  dayWrap: { alignItems: 'center', marginVertical: 10 },
  dayChip: { overflow: 'hidden', paddingVertical: 3, paddingHorizontal: 12, borderRadius: 12, backgroundColor: `${colors.muted}26`, color: colors.muted, fontSize: 12 },
  searchPanel: { gap: 8, padding: 12, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border, backgroundColor: colors.surface },
  hit: { flexDirection: 'row', alignItems: 'flex-start', gap: 8, paddingVertical: 9, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border },
  hitMatch: { backgroundColor: `${colors.accent}40`, fontWeight: '700' },
  voiceRow: { flexDirection: 'row', alignItems: 'center', gap: 10, minWidth: 220 },
  voiceButton: { width: 38, height: 38, borderRadius: 19, backgroundColor: colors.accent, alignItems: 'center', justifyContent: 'center' },
  voiceGlyph: { color: colors.accentText, fontSize: 13, fontWeight: '700' },
  voiceTrack: { flex: 1, height: 4, borderRadius: 2, backgroundColor: `${colors.muted}40`, overflow: 'hidden' },
  voiceFill: { height: 4, backgroundColor: colors.accent },
  docTile: { width: 42, height: 42, borderRadius: 10, backgroundColor: `${colors.accent}24`, alignItems: 'center', justifyContent: 'center' },
  docExt: { color: colors.accent, fontWeight: '700', fontSize: 11 },
  listContent: { padding: 16, gap: 6, flexGrow: 1, justifyContent: 'flex-end' },
  olderLoader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, paddingVertical: 8 },
  mine: { alignSelf: 'flex-end', backgroundColor: colors.mine, borderBottomRightRadius: 5 },
  theirs: { alignSelf: 'flex-start', backgroundColor: colors.surface, borderBottomLeftRadius: 5, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.border },
  quote: { borderLeftWidth: 3, borderLeftColor: colors.accent, backgroundColor: `${colors.accent}22`, borderRadius: 6, paddingHorizontal: 8, paddingVertical: 4, marginBottom: 4 },
  quoteWho: { color: colors.accent, fontWeight: '700', fontSize: 12 },
  replying: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 12, paddingTop: 6 },
  ticks: { fontSize: 11, color: colors.muted, letterSpacing: -2 },
  ticksRead: { color: colors.accent, fontWeight: '700' },
  barTrack: { height: 4, borderRadius: 2, overflow: 'hidden', marginTop: 2 },
  barFill: { height: 4, borderRadius: 2 },
  docButton: { paddingHorizontal: 10, paddingVertical: 6, borderRadius: 8, borderWidth: 1, borderColor: colors.border },
  composer: { paddingHorizontal: 10, paddingTop: 6, paddingBottom: 10, backgroundColor: colors.bg },
  composerPill: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: 2,
    padding: 4,
    borderRadius: 28,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
  },
  composerInput: { flex: 1, maxHeight: 120, minHeight: 44, paddingHorizontal: 8, paddingVertical: 10, color: colors.text, fontSize: 16 },
  roundButton: { width: 44, height: 44, borderRadius: 22, alignItems: 'center', justifyContent: 'center' },
  sendButton: { backgroundColor: colors.accent },
}));
