import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, BackHandler, FlatList, KeyboardAvoidingView, Platform, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { MAX_TEXT_LENGTH, randomId } from '../../../web/shared/crypto';
import { formatFileSize, safeFileName, type FileMessageBody } from '../../../web/shared/file-core';
import {
  CHAT_MOBILE_PREFETCH_SCREENS,
  CHAT_PAGE_SIZE,
  SEND_ERRORS,
  bubbleStatus,
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
import { account, deleteRemoteFile, e2ee, inbox, openConversationPresence, rpc, whenAccountReady } from '../lib/core';
import type { PeerPresence } from '../../../web/shared/presence-core';
import { downloadFile, findSavedFile, openSavedFile, pickFiles, uploadFile, type PickedFile } from '../lib/files';
import { notifyMessageSent } from '../lib/notify';
import { Button } from '../components/Button';
import { MenuItem, PopupMenu } from '../components/PopupMenu';
import { colors, ui } from '../theme';

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
  /** File sudah diunduh ke HP: tombol jadi "Buka" (tanpa unduh ulang). */
  savedUri: string | null;
  /** id pesan yang dibalas (kolom reply_to). */
  replyTo: string | null;
}

type SendParams = Awaited<ReturnType<typeof e2ee.encryptText>> & { p_attachment_id?: string; p_reply_to?: string | null };

const SAVED_NOTE = 'Tersimpan di Download/seru24';

const percent = (done: number, total: number) => `${Math.round((done / Math.max(total, 1)) * 100)}%`;

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
    (async () => {
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
        if (ready !== 'ready') return;
        presenceRef.current = openConversationPresence(conversation.id, setPeerPresence);
        // centang dua tetap benar setelah chat dibuka ulang
        rpc<number>('seru24_peer_read_seq', { p_conversation_id: conversation.id })
          .then(seq => setPeerReadSeq(prev => Math.max(prev, Number(seq) || 0)))
          .catch(() => undefined);

        setKeyStatus(await e2ee.checkPeerKey(peerId));

        if (allMessagesRef.current.length > 0) {
          const initialSlice = sliceMessagesPage(allMessagesRef.current, null, CHAT_PAGE_SIZE);
          const cachedList = await Promise.all(initialSlice.rows.map(toBubble));
          if (!alive) return;
          hasOlderRef.current = initialSlice.hasOlder;
          updateBubbles(() => cachedList);
        }

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
      } catch {
        if (alive) setError('Gagal memuat percakapan');
      }
    })();

    const stop = inbox.onInbox(async (event, payload) => {
      if (payload.conversation_id !== conversation.id) return;
      if (event === 'read') {
        setPeerReadSeq(seq => Math.max(seq, Number(payload.seq) || 0));
        return;
      }
      const msg = payload as unknown as ChatMessage;
      if (deletedIdsRef.current.has(msg.client_msg_id) || msg.seq <= clearedUpToSeqRef.current) return;
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
      presenceRef.current?.close();
      presenceRef.current = null;
    };
  }, [conversation.id, peerId, toBubble, markRead, updateBubbles]);

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

  const deliver = async (build: (retry: boolean) => Promise<SendParams>, localKey: string, retry = false): Promise<void> => {
    const params = await build(retry);
    updateBubble(localKey, { key: params.p_client_msg_id });
    const result = await rpc<SendResult>('seru24_send_message', params);
    if (result.ok) {
      const createdAt = result.created_at ?? new Date().toISOString();
      const seq = result.seq ?? 0;
      const myId = account.me?.id ?? '';
      const cachedMsg: ChatMessage = {
        id: result.id ?? params.p_client_msg_id,
        conversation_id: conversation.id,
        sender_id: myId || null,
        seq,
        client_msg_id: params.p_client_msg_id,
        kind: params.p_kind,
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
      updateBubble(params.p_client_msg_id, { id: result.id ?? null, seq, createdAt, pending: false });
      if (result.id && result.code !== 'duplicate') {
        notifyMessageSent(conversation.id, result.id);
      }
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
      uploaded = await uploadFile(conversation.id, picked, (done, total) =>
        updateBubble(key, { progress: `Mengunggah ${percent(done, total)}` }),
      );
      const meta = uploaded;
      updateBubble(key, { file: meta, progress: '' });
      await deliver(retry => e2ee.encryptFile(conversation.id, peerId, meta, retry).then(params => {
        key = params.p_client_msg_id;
        return params;
      }), key);
    } catch (e) {
      updateBubble(key, { pending: false, progress: '', failed: e instanceof Error && e.message ? e.message : 'Dokumen gagal dikirim' });
    }
    // pesan gagal terkirim: jangan tinggalkan file yatim di Drive
    const sent = bubblesRef.current.find(b => b.key === key);
    if (uploaded && (!sent || sent.failed)) deleteRemoteFile(uploaded.id).catch(() => undefined);
  };

  const attachFiles = async () => {
    setError('');
    const picked = await pickFiles().catch(() => [] as PickedFile[]);
    for (const file of picked) await sendFile(file);
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
      const uri = await downloadFile(item.file, (done, total) => updateBubble(item.key, { progress: `Mengunduh ${percent(done, total)}` }));
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

  const subtitle = peerPresence.typing
    ? 'sedang mengetik…'
    : `@${conversation.peer_username} · ${peerPresence.online ? 'online' : 'terenkripsi end-to-end'}`;

  const cannotSend = keyStatus.status === 'missing' || conversation.peer_blocked;
  const reversedBubbles = useMemo(() => [...bubbles].reverse(), [bubbles]);

  return (
    <KeyboardAvoidingView style={ui.screen} behavior={Platform.OS === 'ios' ? 'padding' : 'height'}>
      <View style={styles.header}>
        <Pressable accessibilityRole="button" accessibilityLabel="Kembali" onPress={onBack} style={{ padding: 8 }}>
          <Text style={{ fontSize: 20, color: colors.accent }}>←</Text>
        </Pressable>
        <View style={{ flex: 1 }}>
          <Text numberOfLines={1} style={{ fontWeight: '700', color: colors.text }}>{peerLabel(conversation)}</Text>
          <Text style={[ui.muted, peerPresence.typing ? { color: colors.accent, fontStyle: 'italic' } : null]}>{subtitle}</Text>
        </View>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Menu percakapan"
          onPress={() => setMenuOpen(true)}
          hitSlop={8}
          style={{ paddingHorizontal: 12, paddingVertical: 8 }}>
          <Text style={{ fontSize: 22, lineHeight: 22, color: colors.text }}>⋮</Text>
        </Pressable>
      </View>
      <PopupMenu open={menuOpen} onClose={() => setMenuOpen(false)}>
        <MenuItem label="Hapus riwayat chat di HP ini" onPress={() => closeMenuThen(clearChatLocally)} />
        <MenuItem
          label={conversation.peer_blocked ? 'Buka blokir' : 'Blokir'}
          danger={!conversation.peer_blocked}
          onPress={() => closeMenuThen(toggleBlock)}
        />
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
        renderItem={({ item }) => (
          <View style={[styles.bubble, item.mine ? styles.mine : styles.theirs, item.failed ? { borderColor: colors.danger } : null]}>
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
            ) : item.file ? (
              <View style={[ui.row, { gap: 10 }]}>
                <Text style={{ fontSize: 22 }}>📎</Text>
                <View style={{ flexShrink: 1 }}>
                  <Text style={{ color: colors.text, fontWeight: '700' }}>{item.file.name}</Text>
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
            <View style={[ui.row, { justifyContent: 'flex-end', gap: 10 }]}>
              <Text style={[ui.muted, { fontSize: 11 }]}>{bubbleStatus(item, peerReadSeq).text}</Text>
              {bubbleStatus(item, peerReadSeq).ticks ? (
                <Text
                  accessibilityLabel={bubbleStatus(item, peerReadSeq).read ? 'Dibaca' : 'Terkirim'}
                  style={[styles.ticks, bubbleStatus(item, peerReadSeq).read ? styles.ticksRead : null]}>
                  {bubbleStatus(item, peerReadSeq).ticks}
                </Text>
              ) : null}
              {item.id && !item.pending && !item.deleted ? (
                <Pressable onPress={() => setReplyingTo(item)} accessibilityRole="button" accessibilityLabel="Balas pesan" hitSlop={8}>
                  <Text style={[ui.muted, { fontSize: 14, lineHeight: 14 }]}>↩</Text>
                </Pressable>
              ) : null}
              {item.mine && item.id && !item.deleted ? (
                <Pressable
                  onPress={() => removeMessage(item)}
                  accessibilityRole="button"
                  accessibilityLabel="Hapus pesan"
                  hitSlop={8}>
                  <Text style={[ui.muted, { fontSize: 14, lineHeight: 14 }]}>✕</Text>
                </Pressable>
              ) : null}
            </View>
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
        <Pressable
          onPress={attachFiles}
          disabled={cannotSend}
          accessibilityRole="button"
          accessibilityLabel="Kirim dokumen (maks 50 MB per file)"
          hitSlop={6}
          style={{ paddingHorizontal: 6, opacity: cannotSend ? 0.4 : 1 }}>
          <Text style={{ fontSize: 22 }}>📎</Text>
        </Pressable>
        <TextInput
          style={[ui.input, { flex: 1, maxHeight: 120 }]}
          value={draft}
          onChangeText={onDraftChange}
          placeholder="Tulis pesan"
          multiline
          editable={!cannotSend}
          maxLength={MAX_TEXT_LENGTH}
        />
        <Button label="Kirim" onPress={send} disabled={!draft.trim() || cannotSend} />
      </View>
    </KeyboardAvoidingView>
  );
};

const styles = StyleSheet.create({
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
  bubble: { maxWidth: '80%', padding: 10, borderRadius: 14, borderWidth: 1, borderColor: colors.border, gap: 2 },
  listContent: { padding: 16, gap: 6, flexGrow: 1, justifyContent: 'flex-end' },
  olderLoader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, paddingVertical: 8 },
  mine: { alignSelf: 'flex-end', backgroundColor: colors.mine },
  theirs: { alignSelf: 'flex-start', backgroundColor: colors.surface },
  quote: { borderLeftWidth: 3, borderLeftColor: '#14b8a6', backgroundColor: 'rgba(15,118,110,0.08)', borderRadius: 6, paddingHorizontal: 8, paddingVertical: 4, marginBottom: 4 },
  quoteWho: { color: colors.accent, fontWeight: '700', fontSize: 12 },
  replying: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 12, paddingTop: 6 },
  ticks: { fontSize: 11, color: colors.muted, letterSpacing: -2 },
  ticksRead: { color: '#0d9488', fontWeight: '700' },
  docButton: { paddingHorizontal: 10, paddingVertical: 6, borderRadius: 8, borderWidth: 1, borderColor: colors.border },
  composer: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: 8,
    padding: 12,
    borderTopWidth: 1,
    borderTopColor: colors.border,
    backgroundColor: colors.surface,
  },
});
