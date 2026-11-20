import React, { useCallback, useEffect, useState } from 'react';
import { Pressable, ScrollView, Switch, Text, View } from 'react-native';
import type { Conversation } from '../../../web/shared/chat-core';
import { account } from '../lib/core';
import { loadLocalConversations } from '../lib/chatStorage';
import { requestNearbyPermissions } from '../lib/nearby';
import {
  acceptIncoming,
  connectTo,
  getRadarError,
  getRadarPeers,
  getNearbyUnread,
  getRadarWarning,
  isRadarOn,
  onRadarChange,
  radarSupported,
  rejectIncoming,
  startRadar,
  strangerKey,
  stopRadar,
  type RadarPeer,
} from '../lib/radar';
import { loadStrangers, onStrangersChange, type StrangerSession } from '../lib/strangers';
import { Avatar } from '../components/Avatar';
import { Button } from '../components/Button';
import { colors, themed, ui } from '../theme';

interface Props {
  onBack: () => void;
  onOpenStranger: (userId: string) => void;
  onOpenContact: (conversation: Conversation) => void;
}

/** Orang di sekitar: kontak yang tersambung otomatis, permintaan masuk, orang asing yang bisa dihubungi, dan obrolan tersimpan. */
export const NearbyScreen = ({ onBack, onOpenStranger, onOpenContact }: Props) => {
  const [on, setOn] = useState(isRadarOn());
  const [peers, setPeers] = useState<RadarPeer[]>(getRadarPeers());
  const [saved, setSaved] = useState<StrangerSession[]>([]);
  const [error, setError] = useState('');

  useEffect(() => {
    const sync = () => {
      setOn(isRadarOn());
      setPeers(getRadarPeers());
    };
    sync();
    return onRadarChange(sync);
  }, []);

  useEffect(() => {
    const load = () => loadStrangers().then(setSaved).catch(() => undefined);
    void load();
    return onStrangersChange(() => void load());
  }, []);

  const toggle = async (value: boolean) => {
    setError('');
    if (!value) {
      await stopRadar();
      return;
    }
    if (!radarSupported) {
      setError('Siaran Dekat hanya tersedia di Android dengan Google Play Services');
      return;
    }
    if (!(await requestNearbyPermissions())) {
      setError('Siaran Dekat butuh izin Perangkat di sekitar dan Lokasi. Aktifkan lewat Pengaturan > Aplikasi > seru24 > Izin');
      return;
    }
    if (!(await startRadar())) setError(`Gagal memulai${getRadarError() ? `: ${getRadarError()}` : ''}. Pastikan Bluetooth dan Wi-Fi aktif`);
  };

  const openContact = useCallback(async (peer: RadarPeer) => {
    const list = await loadLocalConversations(account.me?.id ?? '').catch(() => []);
    const conversation = list.find(c => c.id === peer.contact?.conversationId);
    if (conversation) onOpenContact(conversation);
  }, [onOpenContact]);

  const incoming = peers.filter(p => p.phase === 'incoming');
  const ready = peers.filter(p => p.phase === 'ready');
  const waiting = peers.filter(p => p.phase === 'requesting' || (p.phase === 'connected' && p.initiator));
  const strangers = peers.filter(p => p.phase === 'found' && !p.contact);
  const readyIds = new Set(ready.map(p => p.identity?.userId));
  const history = saved.filter(s => !readyIds.has(s.userId));
  const warning = getRadarWarning();

  return (
    <View style={[ui.screen, { padding: 16, gap: 12 }]}>
      <View style={[ui.row, { justifyContent: 'space-between' }]}>
        <View style={[ui.row, { gap: 10, flex: 1 }]}>
          <Pressable accessibilityRole="button" accessibilityLabel="Kembali" onPress={onBack} hitSlop={8}>
            <Text style={{ color: colors.accent, fontSize: 18 }}>‹ Kembali</Text>
          </Pressable>
        </View>
        <Switch
          value={on}
          onValueChange={value => void toggle(value)}
          trackColor={{ true: colors.accent, false: colors.border }}
          accessibilityLabel="Siaran Dekat: umumkan diri dan cari orang di sekitar tanpa internet"
        />
      </View>
      <Text style={ui.title}>Orang di sekitar</Text>
      {error ? <Text style={ui.error}>{error}</Text> : null}
      {warning ? <Text style={ui.error}>{warning}</Text> : null}

      <ScrollView contentContainerStyle={{ gap: 10, paddingBottom: 24 }}>
        {!on ? (
          <Text style={ui.notice}>
            Nyalakan siaran untuk saling menemukan tanpa internet lewat Bluetooth/Wi-Fi. Yang terlihat orang lain hanya alias
            acak; username baru dikirim setelah tersambung. Sesama kontak tersambung otomatis.
          </Text>
        ) : (
          <Text style={ui.muted}>Siaran aktif. Alias Anda berubah setiap kali siaran dinyalakan.</Text>
        )}

        {incoming.map(peer => (
          <View key={peer.endpointId} style={[ui.card, { gap: 8 }]}>
            <Text style={styles.name}>@{peer.identity?.username} ingin mengobrol</Text>
            <Text style={ui.muted}>Alias {peer.alias}. Kode keamanan (cocokkan lisan): {peer.code}</Text>
            <View style={[ui.row, { gap: 8 }]}>
              <View style={{ flex: 1 }}><Button label="Terima" onPress={() => void acceptIncoming(peer.endpointId)} /></View>
              <View style={{ flex: 1 }}><Button label="Tolak" variant="plain" onPress={() => rejectIncoming(peer.endpointId)} /></View>
            </View>
          </View>
        ))}

        {ready.map(peer => (
          <Pressable
            key={peer.endpointId}
            accessibilityRole="button"
            onPress={() => (peer.contact && peer.trusted ? void openContact(peer) : onOpenStranger(peer.identity!.userId))}
            style={styles.row}>
            <Avatar name={peer.identity?.username ?? peer.alias} seed={peer.identity?.username ?? peer.alias} size={40} />
            <View style={{ flex: 1 }}>
              <Text style={styles.name}>@{peer.identity?.username}</Text>
              <Text style={ui.muted}>{peer.contact && peer.trusted ? 'Kontak' : 'Orang baru'} · tersambung langsung</Text>
            </View>
            {peer.identity && getNearbyUnread(strangerKey(peer.identity.userId)) > 0 ? (
              <Text style={styles.badge}>{getNearbyUnread(strangerKey(peer.identity.userId))}</Text>
            ) : null}
          </Pressable>
        ))}

        {waiting.map(peer => (
          <View key={peer.endpointId} style={styles.row}>
            <Avatar name={peer.alias} seed={peer.alias} size={40} />
            <View style={{ flex: 1 }}>
              <Text style={styles.name}>{peer.alias}</Text>
              <Text style={ui.muted}>Menunggu diterima…</Text>
            </View>
            <Pressable accessibilityRole="button" onPress={() => rejectIncoming(peer.endpointId)} hitSlop={8}>
              <Text style={ui.link}>Batal</Text>
            </Pressable>
          </View>
        ))}

        {strangers.map(peer => (
          <View key={peer.endpointId} style={styles.row}>
            <Avatar name={peer.alias} seed={peer.alias} size={40} />
            <View style={{ flex: 1 }}>
              <Text style={styles.name}>{peer.alias}</Text>
              <Text style={ui.muted}>Di sekitar Anda</Text>
            </View>
            <Pressable accessibilityRole="button" onPress={() => void connectTo(peer.endpointId)} hitSlop={8}>
              <Text style={ui.link}>Hubungi</Text>
            </Pressable>
          </View>
        ))}

        {on && ready.length + incoming.length + waiting.length + strangers.length === 0 ? (
          <Text style={ui.muted}>Mencari… minta orang di dekat Anda menyalakan Siaran Dekat juga.</Text>
        ) : null}

        {history.length > 0 ? <Text style={[ui.label, { marginTop: 8 }]}>Obrolan tersimpan di HP</Text> : null}
        {history.map(session => {
          const unsynced = session.messages.filter(m => m.mine && !m.synced).length;
          return (
            <Pressable key={session.userId} accessibilityRole="button" onPress={() => onOpenStranger(session.userId)} style={styles.row}>
              <Avatar name={session.username} seed={session.username} size={40} />
              <View style={{ flex: 1 }}>
                <Text style={styles.name}>@{session.username}</Text>
                <Text style={ui.muted} numberOfLines={1}>
                  {session.messages.at(-1)?.text ?? 'Belum ada pesan'}
                  {unsynced > 0 ? ` · ${unsynced} menunggu internet` : ''}
                </Text>
              </View>
              {getNearbyUnread(strangerKey(session.userId)) > 0 ? <Text style={styles.badge}>{getNearbyUnread(strangerKey(session.userId))}</Text> : null}
            </Pressable>
          );
        })}
      </ScrollView>
    </View>
  );
};

const styles = themed(() => ({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    padding: 12,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
  },
  name: { color: colors.text, fontWeight: '600' },
  badge: {
    minWidth: 22,
    paddingHorizontal: 7,
    paddingVertical: 2,
    borderRadius: 11,
    overflow: 'hidden',
    textAlign: 'center',
    fontSize: 12,
    fontWeight: '700',
    color: colors.accentText,
    backgroundColor: colors.accent,
  },
}));
