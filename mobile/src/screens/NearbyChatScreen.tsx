import React, { useEffect, useMemo, useState } from 'react';
import { FlatList, KeyboardAvoidingView, Platform, Pressable, Text, TextInput, View } from 'react-native';
import { MAX_TEXT_LENGTH } from '../../../web/shared/crypto';
import { formatTime } from '../../../web/shared/chat-core';
import { onRadarChange, readyPeerFor, sendStrangerText, setRadarActiveChat, strangerKey } from '../lib/radar';
import { loadStrangers, onStrangersChange, type StrangerMessage, type StrangerSession } from '../lib/strangers';
import { Avatar } from '../components/Avatar';
import { colors, themed, ui } from '../theme';

interface Props {
  userId: string;
  onBack: () => void;
}

const statusOf = (message: StrangerMessage) => {
  if (!message.mine) return formatTime(message.createdAt);
  if (message.synced) return `${formatTime(message.createdAt)} · tersimpan di server`;
  if (message.acked) return `${formatTime(message.createdAt)} · diterima, tersimpan di server saat online`;
  return `${formatTime(message.createdAt)} · menunggu tersambung atau internet`;
};

/** Obrolan dengan orang yang belum pernah chat lewat Siaran Dekat; disimpan di HP dan diunggah saat online. */
export const NearbyChatScreen = ({ userId, onBack }: Props) => {
  const [session, setSession] = useState<StrangerSession | null>(null);
  const [connected, setConnected] = useState(Boolean(readyPeerFor(userId)));
  const [draft, setDraft] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    const load = () => loadStrangers().then(list => setSession(list.find(s => s.userId === userId) ?? null)).catch(() => undefined);
    void load();
    return onStrangersChange(() => void load());
  }, [userId]);

  useEffect(() => {
    const sync = () => setConnected(Boolean(readyPeerFor(userId)));
    sync();
    return onRadarChange(sync);
  }, [userId]);

  useEffect(() => {
    setRadarActiveChat(strangerKey(userId));
    return () => setRadarActiveChat(null);
  }, [userId]);

  const data = useMemo(() => [...(session?.messages ?? [])].reverse(), [session]);

  const send = async () => {
    const text = draft.trim();
    if (!text) return;
    setDraft('');
    setError('');
    try {
      await sendStrangerText(userId, text);
    } catch (e) {
      setDraft(text);
      setError(e instanceof Error && e.message ? e.message : 'Pesan gagal dikirim');
    }
  };

  if (!session) {
    return (
      <View style={[ui.screen, { padding: 16, gap: 12 }]}>
        <Pressable accessibilityRole="button" onPress={onBack}><Text style={ui.link}>‹ Kembali</Text></Pressable>
        <Text style={ui.muted}>Obrolan sudah tersimpan di server dan tampil di daftar chat.</Text>
      </View>
    );
  }

  return (
    <KeyboardAvoidingView style={ui.screen} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <View style={styles.header}>
        <Pressable accessibilityRole="button" accessibilityLabel="Kembali" onPress={onBack} hitSlop={8}>
          <Text style={{ color: colors.accent, fontSize: 22 }}>‹</Text>
        </Pressable>
        <Avatar name={session.username} seed={session.username} size={36} />
        <View style={{ flex: 1 }}>
          <Text numberOfLines={1} style={{ fontWeight: '700', color: colors.text }}>@{session.username}</Text>
          <Text style={ui.muted}>{connected ? 'tersambung langsung · tanpa internet' : 'tidak tersambung · tersimpan di HP'}</Text>
        </View>
      </View>
      {session.unverified ? (
        <Text style={[ui.notice, { margin: 12 }]}>Username ini tidak cocok dengan akun di server, jadi obrolan tidak diunggah.</Text>
      ) : null}
      {session.keyWarning ? (
        <Text style={[ui.notice, { margin: 12 }]}>Kunci enkripsi yang diterima saat bertemu berbeda dari kunci di server. Cocokkan kode keamanan sebelum mempercayai obrolan ini.</Text>
      ) : null}
      <FlatList
        inverted
        data={data}
        keyExtractor={m => m.id}
        contentContainerStyle={{ padding: 12, gap: 6 }}
        renderItem={({ item }) => (
          <View style={[styles.bubble, item.mine ? styles.mine : styles.theirs]}>
            <Text style={{ color: colors.text }}>{item.text}</Text>
            <Text style={[ui.muted, { fontSize: 11, textAlign: 'right' }]}>{statusOf(item)}</Text>
          </View>
        )}
      />
      {error ? <Text style={[ui.error, { paddingHorizontal: 12 }]}>{error}</Text> : null}
      <View style={styles.composer}>
        <TextInput
          style={[ui.input, { flex: 1 }]}
          value={draft}
          onChangeText={setDraft}
          placeholder="Tulis pesan"
          placeholderTextColor={colors.muted}
          maxLength={MAX_TEXT_LENGTH}
          multiline
        />
        <Pressable accessibilityRole="button" accessibilityLabel="Kirim" onPress={() => void send()} disabled={!draft.trim()} style={styles.send}>
          <Text style={{ color: colors.accentText, fontWeight: '700' }}>Kirim</Text>
        </Pressable>
      </View>
    </KeyboardAvoidingView>
  );
};

const styles = themed(() => ({
  header: { flexDirection: 'row', alignItems: 'center', gap: 10, padding: 12, borderBottomWidth: 1, borderBottomColor: colors.border },
  bubble: { maxWidth: '82%', padding: 10, borderRadius: 14, gap: 2 },
  mine: { alignSelf: 'flex-end', backgroundColor: `${colors.accent}30` },
  theirs: { alignSelf: 'flex-start', backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border },
  composer: { flexDirection: 'row', alignItems: 'flex-end', gap: 8, padding: 10 },
  send: { backgroundColor: colors.accent, borderRadius: 12, paddingHorizontal: 16, paddingVertical: 12 },
}));
