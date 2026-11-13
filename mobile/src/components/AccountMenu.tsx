import React, { useState } from 'react';
import { Linking, Modal, Pressable, StyleSheet, Switch, Text, View } from 'react-native';
import { account, signOut, webUrl } from '../lib/core';
import { disableNotifications, enableNotifications, isNotifyEnabled, notifySupported } from '../lib/notify';
import { colors, ui } from '../theme';

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
  const me = account.me;

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
      <Modal transparent visible={open} animationType="fade" onRequestClose={() => setOpen(false)}>
        <Pressable style={styles.backdrop} onPress={() => setOpen(false)}>
          <View style={styles.menu}>
            <View style={styles.who}>
              <Text style={{ fontWeight: '700', color: colors.text }}>{name}</Text>
              <Text style={ui.muted}>@{me?.username}</Text>
            </View>
            <MenuItem label="Edit profil" onPress={() => openWeb('/akun/profil')} />
            <MenuItem label="Ganti password" onPress={() => openWeb('/akun/password')} />
            {notifySupported ? (
              <View style={[styles.item, styles.toggle]}>
                <Text style={{ color: colors.text }}>Notifikasi</Text>
                <Switch value={notify} onValueChange={toggleNotify} trackColor={{ true: colors.accent }} />
              </View>
            ) : null}
            {notifyHint ? <Text style={[ui.error, { fontSize: 12, paddingHorizontal: 10 }]}>{notifyHint}</Text> : null}
            <MenuItem label="Keluar" danger onPress={logout} />
          </View>
        </Pressable>
      </Modal>
    </>
  );
};

const MenuItem = ({ label, onPress, danger }: { label: string; onPress: () => void; danger?: boolean }) => (
  <Pressable accessibilityRole="menuitem" onPress={onPress} style={styles.item}>
    <Text style={{ color: danger ? colors.danger : colors.text }}>{label}</Text>
  </Pressable>
);

const styles = StyleSheet.create({
  avatar: { width: 40, height: 40, borderRadius: 20, alignItems: 'center', justifyContent: 'center' },
  initials: { color: '#fff', fontWeight: '700' },
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.15)', alignItems: 'flex-end', paddingTop: 64, paddingRight: 16 },
  menu: { minWidth: 220, backgroundColor: colors.surface, borderRadius: 12, padding: 6, elevation: 6 },
  who: { padding: 10, borderBottomWidth: 1, borderBottomColor: colors.border, marginBottom: 4 },
  item: { paddingVertical: 11, paddingHorizontal: 10, borderRadius: 8 },
  toggle: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingVertical: 4 },
});
