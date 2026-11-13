import React, { useCallback, useEffect, useState } from 'react';
import { FlatList, Pressable, RefreshControl, StyleSheet, Text, TextInput, View } from 'react-native';
import { formatTime, isIncomingRequest, peerLabel, type Conversation, type FoundUser } from '../../../web/shared/chat-core';
import { account, inbox, listConversations, rpc } from '../lib/core';
import { AccountMenu } from '../components/AccountMenu';
import { Button } from '../components/Button';
import { colors, ui } from '../theme';

interface Props {
  onOpen: (conversation: Conversation) => void;
  onSignedOut: () => void;
}

export const ChatListScreen = ({ onOpen, onSignedOut }: Props) => {
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [query, setQuery] = useState('');
  const [found, setFound] = useState<FoundUser | null>(null);
  const [searched, setSearched] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    try {
      setConversations(await listConversations());
    } catch {
      setError('Gagal memuat percakapan');
    }
  }, []);

  useEffect(() => {
    load();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const stop = inbox.onInbox(event => {
      if (event !== 'message_new') return;
      clearTimeout(timer);
      timer = setTimeout(load, 300);
    });
    return () => {
      stop();
      clearTimeout(timer);
    };
  }, [load]);

  const search = async () => {
    setError('');
    setFound(null);
    setSearched(false);
    const username = query.trim().toLowerCase().replace(/^@/, '');
    if (!username) return;
    setBusy(true);
    try {
      const rows = await rpc<FoundUser[]>('seru24_search_user', { p_username: username });
      setFound(rows[0] ?? null);
      setSearched(true);
    } catch {
      setError('Pencarian gagal');
    } finally {
      setBusy(false);
    }
  };

  const startChat = async (user: FoundUser) => {
    setBusy(true);
    try {
      const result = await rpc<{ ok: boolean; conversation_id?: string }>('seru24_start_direct_chat', { p_target: user.id });
      if (!result.ok || !result.conversation_id) {
        setError('Tidak dapat memulai percakapan dengan pengguna ini');
        return;
      }
      const list = await listConversations();
      setConversations(list);
      const conversation = list.find(c => c.id === result.conversation_id);
      if (conversation) onOpen(conversation);
    } catch {
      setError('Tidak dapat memulai percakapan');
    } finally {
      setBusy(false);
    }
  };

  const refresh = async () => {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  };

  return (
    <View style={[ui.screen, { padding: 16, gap: 12 }]}>
      <View style={[ui.row, { justifyContent: 'space-between' }]}>
        <Text style={ui.brand}>seru24</Text>
        <AccountMenu onSignedOut={onSignedOut} />
      </View>

      <View style={ui.row}>
        <TextInput
          style={[ui.input, { flex: 1 }]}
          value={query}
          onChangeText={setQuery}
          placeholder="Cari username persis, mis. zidane_21"
          autoCapitalize="none"
          autoCorrect={false}
          returnKeyType="search"
          onSubmitEditing={search}
          maxLength={31}
        />
        <Button label="Cari" onPress={search} busy={busy} />
      </View>
      {found ? (
        <View style={[ui.card, ui.row, { justifyContent: 'space-between', padding: 12 }]}>
          <View>
            <Text style={{ fontWeight: '700', color: colors.text }}>{found.display_name || `@${found.username}`}</Text>
            <Text style={ui.muted}>@{found.username}</Text>
          </View>
          <Button label="Chat" onPress={() => startChat(found)} busy={busy} />
        </View>
      ) : searched ? (
        <Text style={ui.muted}>Pengguna tidak ditemukan.</Text>
      ) : null}
      {error ? <Text style={ui.error}>{error}</Text> : null}

      <FlatList
        data={conversations}
        keyExtractor={c => c.id}
        contentContainerStyle={{ gap: 8 }}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={refresh} />}
        ListEmptyComponent={<Text style={[ui.muted, { textAlign: 'center', paddingVertical: 24 }]}>Belum ada percakapan. Cari teman dengan username-nya.</Text>}
        renderItem={({ item }) => (
          <Pressable onPress={() => onOpen(item)} style={[ui.card, styles.item]}>
            <View style={{ flex: 1 }}>
              <Text numberOfLines={1} style={{ fontWeight: '700', color: colors.text }}>{peerLabel(item)}</Text>
              <Text style={ui.muted}>
                {isIncomingRequest(item, account.me?.id)
                  ? 'Permintaan chat baru'
                  : item.status === 'pending'
                    ? 'Menunggu diterima'
                    : `@${item.peer_username}`}
              </Text>
            </View>
            <View style={{ alignItems: 'flex-end', gap: 4 }}>
              <Text style={ui.muted}>{formatTime(item.last_message_at)}</Text>
              {item.unread > 0 ? <Text style={styles.badge}>{item.unread}</Text> : null}
            </View>
          </Pressable>
        )}
      />
    </View>
  );
};

const styles = StyleSheet.create({
  item: { flexDirection: 'row', alignItems: 'center', padding: 12, gap: 8 },
  badge: {
    minWidth: 22,
    paddingHorizontal: 7,
    borderRadius: 11,
    overflow: 'hidden',
    backgroundColor: colors.accent,
    color: colors.accentText,
    fontSize: 12,
    textAlign: 'center',
  },
});
