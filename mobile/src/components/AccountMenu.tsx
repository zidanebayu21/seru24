import React, { useCallback, useEffect, useState } from 'react';
import { Linking, Pressable, StyleSheet, Switch, Text, View } from 'react-native';
import {
  clearAllLocalChats,
  getLocalChatStorageStats,
  resetFullLocalStorage,
  type LocalChatStorageStats,
} from '../lib/chatStorage';
import { account, signOut, webUrl } from '../lib/core';
import { disableNotifications, enableNotifications, isNotifyEnabled, notifySupported } from '../lib/notify';
import { colors, ui } from '../theme';
import { MenuItem, menuStyles, PopupMenu } from './PopupMenu';

interface Props {
  onSignedOut: () => void;
}

const initialsOf = (name: string) =>
  name.split(/[\s_]+/).filter(Boolean).slice(0, 2).map(part => part[0]!.toUpperCase()).join('') || '?';

// warna tetap per username agar avatar mudah dikenali
const hueOf = (username: string) => [...username].reduce((sum, ch) => sum + ch.charCodeAt(0), 0) % 360;

export const AccountMenu = ({ onSignedOut }: Props) => {
  const [open, setOpen] = useState(false);
  const [notify, setNotify] = useState(isNotifyEnabled());
  const [notifyHint, setNotifyHint] = useState('');
  const [stats, setStats] = useState<LocalChatStorageStats>({ conversations: 0, messages: 0, sizeBytes: null });
  const [storageBusy, setStorageBusy] = useState(false);
  const [storageNote, setStorageNote] = useState('');
  const [confirmReset, setConfirmReset] = useState(false);
  const me = account.me;

  const formatBytes = (bytes: number | null) => {
    if (bytes === null) return 'ukuran lokal';
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
  };

  const refreshStats = useCallback(async () => {
    if (!me?.id) return;
    setStats(await getLocalChatStorageStats(me.id));
  }, [me?.id]);

  useEffect(() => {
    if (!open) {
      setConfirmReset(false);
      return;
    }
    setStorageNote('');
    refreshStats().catch(() => undefined);
  }, [open, refreshStats]);

  const handleClearChats = async () => {
    if (storageBusy) return;
    setStorageBusy(true);
    setConfirmReset(false);
    setStorageNote('');
    try {
      await clearAllLocalChats(me?.id);
      await refreshStats();
      setStorageNote('Cache chat lokal dibersihkan.');
    } finally {
      setStorageBusy(false);
    }
  };

  const handleResetDb = async () => {
    if (storageBusy) return;
    if (!confirmReset) {
      setConfirmReset(true);
      return;
    }
    setStorageBusy(true);
    setConfirmReset(false);
    setStorageNote('');
    try {
      await resetFullLocalStorage(me?.id);
      await refreshStats();
      setStorageNote('Database chat lokal direset penuh.');
    } finally {
      setStorageBusy(false);
    }
  };

  const toggleNotify = async (on: boolean) => {
    setNotifyHint('');
    if (!on) {
      await disableNotifications();
      setNotify(false);
      return;
    }
    const granted = await enableNotifications();
    setNotify(granted);
    if (!granted) setNotifyHint('Izin notifikasi ditolak. Aktifkan di Pengaturan > Aplikasi > seru24.');
  };
  const name = me?.display_name || me?.username || '';

  const openWeb = (path: string) => {
    setOpen(false);
    Linking.openURL(webUrl(path));
  };

  const logout = async () => {
    setOpen(false);
    await signOut();
    onSignedOut();
  };

  return (
    <>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Menu akun"
        onPress={() => setOpen(true)}
        style={[styles.avatar, { backgroundColor: `hsl(${hueOf(me?.username ?? '')}, 55%, 42%)` }]}>
        <Text style={styles.initials}>{initialsOf(name)}</Text>
      </Pressable>
      <PopupMenu open={open} onClose={() => setOpen(false)}>
        <View style={styles.who}>
          <Text style={{ fontWeight: '700', color: colors.text }}>{name}</Text>
          <Text style={ui.muted}>@{me?.username}</Text>
        </View>
        <MenuItem label="Edit profil" onPress={() => openWeb('/akun/profil')} />
        <MenuItem label="Ganti password" onPress={() => openWeb('/akun/password')} />
        {notifySupported ? (
          <View style={[menuStyles.item, styles.toggle]}>
            <Text style={{ color: colors.text }}>Notifikasi</Text>
            <Switch value={notify} onValueChange={toggleNotify} trackColor={{ true: colors.accent }} />
          </View>
        ) : null}
        {notifyHint ? <Text style={[ui.error, { fontSize: 12, paddingHorizontal: 10 }]}>{notifyHint}</Text> : null}
        <View style={styles.storageBox}>
          <Text style={[ui.muted, { fontSize: 12 }]}>
            DB Lokal: {stats.conversations} chat · {stats.messages} pesan ({formatBytes(stats.sizeBytes)})
          </Text>
          {storageNote ? <Text style={[ui.muted, { fontSize: 12, color: colors.accent }]}>{storageNote}</Text> : null}
        </View>
        <MenuItem label="Bersihkan chat lokal" onPress={handleClearChats} />
        <MenuItem
          label={confirmReset ? 'Ketuk lagi: konfirmasi reset DB chat' : 'Reset penuh DB chat'}
          danger
          onPress={handleResetDb}
        />
        <MenuItem label="Keluar" danger onPress={logout} />
      </PopupMenu>
    </>
  );
};

const styles = StyleSheet.create({
  avatar: { width: 40, height: 40, borderRadius: 20, alignItems: 'center', justifyContent: 'center' },
  initials: { color: '#fff', fontWeight: '700' },
  who: { padding: 10, borderBottomWidth: 1, borderBottomColor: colors.border, marginBottom: 4 },
  storageBox: { paddingHorizontal: 10, paddingVertical: 6, borderTopWidth: 1, borderTopColor: colors.border, marginTop: 4 },
  toggle: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingVertical: 4 },
});
