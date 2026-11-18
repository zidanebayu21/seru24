import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, BackHandler, FlatList, KeyboardAvoidingView, Platform, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { MAX_TEXT_LENGTH } from '../../../web/shared/crypto';
import {
  CHAT_MOBILE_PREFETCH_SCREENS,
  CHAT_PAGE_SIZE,
  SEND_ERRORS,
  formatTime,
  isIncomingRequest,
  markMessageDeleted,
  mergeCachedMessages,
  mergePagedBubbles,
  oldestPersistedSeq,
  peerLabel,
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
import { account, deleteRemoteFile, e2ee, inbox, rpc, whenAccountReady } from '../lib/core';
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
}

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
  }), [peerId]);

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
        // balasan pertama dari lawan bicara = permintaan chat kita diterima
        setConversation(c => (c.status === 'pending' && payload.sender_id === c.peer_id ? { ...c, status: 'accepted' } : c));
        if (!bubble.mine) markRead(bubble.seq);
      }
    });
    return () => {
      alive = false;
      stop();
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

  const sendText = async (text: string, localKey: string, retry = false): Promise<void> => {
    const params = await e2ee.encryptText(conversation.id, peerId, text, retry);
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
        kind: 'text',
        ciphertext: params.p_ciphertext,
        nonce: params.p_nonce,
        sender_key_version: params.p_sender_key_version,
        recipient_key_version: params.p_recipient_key_version,
        reply_to: null,
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
      return sendText(text, params.p_client_msg_id, true);
    }
    updateBubble(params.p_client_msg_id, { pending: false, failed: SEND_ERRORS[result.code ?? ''] ?? 'Pesan gagal dikirim' });
  };

  const send = async () => {
    const text = draft.trim();
    if (!text) return;
    setDraft('');
    setError('');
    const localKey = `local-${Date.now()}`;
    updateBubbles(list => [...list, {
      key: localKey, id: null, seq: 0, mine: true, text, createdAt: new Date().toISOString(),
      deleted: false, pending: true, failed: '',
    }]);
    listRef.current?.scrollToOffset({ offset: 0, animated: true });
    try {
      await sendText(text, localKey);
      if (isIncomingRequest(conversation, account.me?.id)) setConversation(c => ({ ...c, status: 'accepted' }));
    } catch (e) {
      updateBubbles(list => list.map(b => (b.pending && b.text === text ? { ...b, pending: false, failed: e instanceof Error ? e.message : 'Pesan gagal dikirim' } : b)));
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

  const statusOf = (b: Bubble) => {
    if (b.pending) return 'mengirim…';
    if (b.failed) return b.failed;
    return b.mine && b.seq <= peerReadSeq ? 'dibaca' : formatTime(b.createdAt);
  };

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
          <Text style={ui.muted}>@{conversation.peer_username} · terenkripsi end-to-end</Text>
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
            {item.deleted ? (
              <Text style={ui.muted}>Pesan dihapus</Text>
            ) : item.text === null ? (
              <Text style={ui.muted}>Pesan tidak dapat dibuka</Text>
            ) : (
              <Text style={{ color: colors.text }}>{item.text}</Text>
            )}
            <View style={[ui.row, { justifyContent: 'flex-end', gap: 10 }]}>
              <Text style={[ui.muted, { fontSize: 11 }]}>{statusOf(item)}</Text>
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

      <View style={styles.composer}>
        <TextInput
          style={[ui.input, { flex: 1, maxHeight: 120 }]}
          value={draft}
          onChangeText={setDraft}
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
