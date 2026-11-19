import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, AppState, FlatList, Pressable, RefreshControl, StyleSheet, Switch, Text, TextInput, View } from 'react-native';
import {
  CONVERSATION_PAGE_SIZE,
  appendConversations,
  cacheableConversations,
  formatTime,
  isIncomingRequest,
  peerLabel,
  type Conversation,
  type FoundUser,
} from '../../../web/shared/chat-core';
import { loadLocalConversations, saveLocalConversations } from '../lib/chatStorage';
import { account, inbox, listConversations, rpc } from '../lib/core';
import { getPreview, previewFromEvent, refreshPreviews } from '../lib/previews';
import { requestNearbyPermissions } from '../lib/nearby';
import { getRadarError, getRadarPeers, isRadarOn, onRadarChange, radarSupported, startRadar, stopRadar } from '../lib/radar';
import { isStandby, loadStandby, setStandby } from '../lib/standby';
import { AccountMenu } from '../components/AccountMenu';
import { Avatar } from '../components/Avatar';
import { Button } from '../components/Button';
import { UpdateBanner } from '../components/UpdateBanner';
import { colors, themed, ui } from '../theme';

interface Props {
  onOpen: (conversation: Conversation) => void;
  onOpenNearby: () => void;
  onSignedOut: () => void;
}

export const ChatListScreen = ({ onOpen, onOpenNearby, onSignedOut }: Props) => {
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [query, setQuery] = useState('');
  const [found, setFound] = useState<FoundUser | null>(null);
  const [searched, setSearched] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  // sinkronisasi dengan server berjalan di belakang daftar dari cache lokal
  const [syncing, setSyncing] = useState(true);
  const [hasMore, setHasMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const conversationsRef = useRef<Conversation[]>([]);
  conversationsRef.current = conversations;
  // cuplikan pesan terakhir (didekripsi di HP) dan mode standby (koneksi realtime tetap hidup di latar belakang)
  const [previewTick, setPreviewTick] = useState(0);
  const [standby, setStandbyState] = useState(isStandby());

  useEffect(() => {
    loadStandby().then(setStandbyState).catch(() => undefined);
  }, []);

  // Siaran Dekat: umumkan diri dan cari HP lain tanpa internet; sesama kontak tersambung otomatis
  const [radarOn, setRadarOn] = useState(isRadarOn());
  const [radarRequests, setRadarRequests] = useState(0);
  useEffect(() => {
    const sync = () => {
      setRadarOn(isRadarOn());
      setRadarRequests(getRadarPeers().filter(p => p.phase === 'incoming').length);
    };
    sync();
    return onRadarChange(sync);
  }, []);

  const toggleRadar = async (on: boolean) => {
    if (!on) {
      await stopRadar();
      return;
    }
    if (!radarSupported) {
      setError('Siaran Dekat hanya tersedia di Android dengan Google Play Services');
    } else if (!(await requestNearbyPermissions())) {
      setError('Siaran Dekat butuh izin Perangkat di sekitar dan Lokasi. Aktifkan lewat Pengaturan > Aplikasi > seru24 > Izin');
    } else if (!(await startRadar())) {
      setError(`Siaran Dekat gagal dinyalakan${getRadarError() ? `: ${getRadarError()}` : ''}. Pastikan Bluetooth dan Wi-Fi aktif`);
    }
  };

  const toggleStandby = (on: boolean) => {
    setStandbyState(on);
    setStandby(on).catch(() => undefined);
  };

  useEffect(() => {
    refreshPreviews(conversations, () => setPreviewTick(tick => tick + 1)).catch(() => undefined);
  }, [conversations]);

  /** Daftar sebagian: percakapan lama di cache yang belum dimuat dipertahankan; daftar lengkap menggantikan cache. */
  const saveCache = async (myId: string | undefined, list: Conversation[], more: boolean) => {
    if (!myId) return;
    const cached = more ? await loadLocalConversations(myId).catch(() => [] as Conversation[]) : [];
    saveLocalConversations(myId, cacheableConversations(list, cached, more)).catch(() => undefined);
  };

  const load = useCallback(async () => {
    const myId = account.me?.id;
    let hasCached = false;
    if (myId) {
      const cached = await loadLocalConversations(myId).catch(() => []);
      if (cached.length > 0) {
        hasCached = true;
        setConversations(prev => (prev.length === 0 ? cached : prev));
      }
    }
    setSyncing(true);
    try {
      // muat ulang sebanyak yang sudah tampil (minimal satu halaman) agar daftar tidak menciut saat ada pesan baru
      const limit = Math.max(CONVERSATION_PAGE_SIZE, conversationsRef.current.length);
      const fresh = await listConversations({ limit });
      const more = fresh.length >= limit;
      setConversations(fresh);
      setHasMore(more);
      setError('');
      await saveCache(myId, fresh, more);
    } catch {
      if (!hasCached) setError('Gagal memuat percakapan');
    } finally {
      setSyncing(false);
    }
  }, []);

  useEffect(() => {
    void load().catch(() => {});
    let timer: ReturnType<typeof setTimeout> | undefined;
    const stop = inbox.onInbox((event, payload) => {
      if (event === 'message_new' || event === 'message_update') {
        // cuplikan langsung diperbarui dari pesan yang masuk, tanpa menunggu daftar dimuat ulang
        const target = conversationsRef.current.find(c => c.id === payload.conversation_id);
        if (target) {
          previewFromEvent(payload, target.peer_id)
            .then(changed => {
              if (changed) setPreviewTick(tick => tick + 1);
            })
            .catch(() => undefined);
        }
      }
      if (event !== 'message_new') return;
      clearTimeout(timer);
      timer = setTimeout(() => {
        void load().catch(() => {});
      }, 300);
    });
    // aktif lagi setelah di latar belakang (realtime putus): susul jumlah belum dibaca dan urutan
    const appState = AppState.addEventListener('change', state => {
      if (state === 'active') {
        void load().catch(() => {});
      }
    });
    return () => {
      stop();
      appState.remove();
      clearTimeout(timer);
    };
  }, [load]);

  const loadMore = async () => {
    if (loadingMore || !hasMore) return;
    setLoadingMore(true);
    try {
      const current = conversationsRef.current;
      const page = await listConversations({ limit: CONVERSATION_PAGE_SIZE, offset: current.length });
      const merged = appendConversations(current, page);
      const more = page.length >= CONVERSATION_PAGE_SIZE;
      setConversations(merged);
      setHasMore(more);
      await saveCache(account.me?.id, merged, more);
    } catch {
      setError('Gagal memuat percakapan berikutnya');
    } finally {
      setLoadingMore(false);
    }
  };

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
      // hanya percakapan ini yang diambil (bisa di luar halaman yang sudah dimuat), lalu ditaruh paling atas
      const [conversation] = await listConversations({ id: result.conversation_id });
      if (conversation) {
        setConversations(prev => appendConversations([conversation], prev));
        onOpen(conversation);
      }
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
        <View style={[ui.row, { gap: 8 }]}>
          <Text style={styles.title}>Chat</Text>
          {syncing ? <ActivityIndicator size="small" color={colors.accent} accessibilityLabel="Menyinkronkan" /> : null}
        </View>
        <View style={[ui.row, { gap: 6 }]}>
          <Text style={[ui.muted, { fontSize: 12 }]}>Dekat</Text>
          <Switch
            value={radarOn}
            onValueChange={value => void toggleRadar(value)}
            trackColor={{ true: colors.accent, false: colors.border }}
            accessibilityLabel="Siaran Dekat: umumkan diri dan cari orang di sekitar tanpa internet"
          />
          <Text style={[ui.muted, { fontSize: 12 }]}>Standby</Text>
          <Switch
            value={standby}
            onValueChange={toggleStandby}
            trackColor={{ true: colors.accent, false: colors.border }}
            accessibilityLabel="Standby: tetap tersambung di latar belakang agar pesan masuk terlihat tanpa membuka chat"
          />
          <AccountMenu onSignedOut={onSignedOut} />
        </View>
      </View>

      <UpdateBanner />

      {radarOn ? (
        <Pressable accessibilityRole="button" onPress={onOpenNearby} style={ui.notice}>
          <Text style={{ color: colors.text }}>
            Siaran Dekat aktif{radarRequests > 0 ? ` · ${radarRequests} permintaan baru` : ''}. Ketuk untuk melihat orang di sekitar.
          </Text>
        </Pressable>
      ) : null}

      <View style={ui.row}>
        <TextInput
          style={[ui.input, { flex: 1, borderRadius: 24, paddingHorizontal: 18 }]}
          value={query}
          onChangeText={setQuery}
          placeholder="Cari username persis, mis. zidane_21"
          placeholderTextColor={colors.muted}
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
        contentContainerStyle={{ paddingBottom: 24 }}
        extraData={previewTick}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={refresh} />}
        onEndReached={loadMore}
        onEndReachedThreshold={0.5}
        ListFooterComponent={loadingMore ? <ActivityIndicator style={{ paddingVertical: 12 }} /> : undefined}
        ListEmptyComponent={<Text style={[ui.muted, { textAlign: 'center', paddingVertical: 24 }]}>Belum ada percakapan. Cari teman dengan username-nya.</Text>}
        renderItem={({ item }) => (
          <Pressable
            onPress={() => onOpen(item)}
            android_ripple={{ color: `${colors.accent}22` }}
            accessibilityRole="button"
            accessibilityLabel={`Buka chat dengan ${peerLabel(item)}`}
            style={styles.item}>
            <Avatar name={peerLabel(item)} seed={item.peer_username} size={52} />
            <View style={{ flex: 1, gap: 3 }}>
              <View style={styles.line}>
                <Text numberOfLines={1} style={styles.name}>{peerLabel(item)}</Text>
                <Text style={[styles.time, item.unread > 0 ? styles.timeFresh : null]}>{formatTime(item.last_message_at)}</Text>
              </View>
              <View style={styles.line}>
                <Text numberOfLines={1} style={[ui.muted, { flex: 1, fontSize: 14 }, item.unread > 0 ? { color: colors.text, fontWeight: '600' } : null]}>
                  {isIncomingRequest(item, account.me?.id)
                    ? 'Permintaan chat baru'
                    : item.status === 'pending'
                      ? 'Menunggu diterima'
                      : (getPreview(item.id)?.text ?? `@${item.peer_username}`)}
                </Text>
                {item.unread > 0 ? <Text style={styles.badge}>{item.unread}</Text> : null}
              </View>
            </View>
          </Pressable>
        )}
      />
    </View>
  );
};

const styles = themed(() => ({
  title: { fontSize: 30, fontWeight: '800', color: colors.text, letterSpacing: -0.8 },
  item: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
    paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
  },
  line: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 10 },
  name: { flex: 1, fontSize: 16, fontWeight: '600', color: colors.text },
  time: { fontSize: 12, color: colors.muted },
  timeFresh: { color: colors.accent, fontWeight: '600' },
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
}));
