import React, { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, AppState, StatusBar, View } from 'react-native';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import type { Conversation } from '../../web/shared/chat-core';
import { loadCachedAccount, restoreSession, setRealtimeActive, type RestoreStatus } from './lib/core';
import { isStandby, loadStandby } from './lib/standby';
import { flushOutbox } from './lib/outbox';
import { loadNotifySetting, startNotifications, stopNotifications, updateNotificationPresence } from './lib/notify';
import { AuthScreen } from './screens/AuthScreen';
import { ChatListScreen } from './screens/ChatListScreen';
import { ChatScreen } from './screens/ChatScreen';
import { colors, isDarkMode, loadTheme, onThemeChange, themeVersion, ui } from './theme';

// boot = membaca profil tersimpan (sekejap, layar kosong); loading = belum pernah masuk di perangkat ini
type Screen = { name: 'boot' } | { name: 'loading' } | { name: 'auth' } | { name: 'list' } | { name: 'chat'; conversation: Conversation };

const RETRY_MS = 15_000;

const App = () => {
  const [screen, setScreen] = useState<Screen>({ name: 'boot' });
  const activeConversation = useRef<string | null>(null);
  const [themeTick, setThemeTick] = useState(0);
  const signedIn = screen.name === 'list' || screen.name === 'chat';

  // Daftar chat dari cache lokal tampil seketika; sesi dan kunci dipulihkan di belakang.
  // 'offline' = sinyal belum ada: tetap di daftar (cache), dicoba lagi berkala dan saat app dibuka kembali.
  useEffect(() => {
    let cancelled = false;
    let retry: ReturnType<typeof setTimeout> | undefined;

    const settle = (status: RestoreStatus) => {
      if (cancelled) return;
      if (status === 'offline') {
        setScreen(current => (current.name === 'loading' || current.name === 'boot' ? { name: 'auth' } : current));
        retry = setTimeout(() => restoreSession().then(settle).catch(() => undefined), RETRY_MS);
        return;
      }
      setScreen(current => {
        if (status !== 'ready') return { name: 'auth' };
        return current.name === 'loading' || current.name === 'boot' ? { name: 'list' } : current;
      });
      if (status === 'ready') flushOutbox().catch(() => undefined);
    };

    loadTheme()
      .catch(() => undefined)
      .then(() => loadCachedAccount())
      .then(cached => {
        setScreen(cached ? { name: 'list' } : { name: 'loading' });
        return restoreSession();
      })
      .then(settle)
      .catch(() => setScreen({ name: 'auth' }));

    loadStandby().catch(() => undefined);
    const sub = AppState.addEventListener('change', state => {
      // mode standby: koneksi realtime tidak diputus di latar belakang
      setRealtimeActive(state === 'active' || isStandby());
      if (state === 'active') flushOutbox().catch(() => undefined);
    });
    return () => {
      cancelled = true;
      clearTimeout(retry);
      sub.remove();
    };
  }, []);

  useEffect(() => onThemeChange(() => setThemeTick(themeVersion())), []);

  useEffect(() => {
    activeConversation.current = screen.name === 'chat' ? screen.conversation.id : null;
    if (signedIn) updateNotificationPresence(activeConversation.current);
  }, [screen, signedIn]);

  // notifikasi pesan baru selama sudah masuk; berhenti saat keluar
  useEffect(() => {
    if (!signedIn) return;
    let cancelled = false;
    void loadNotifySetting().then(() => {
      if (!cancelled) startNotifications(() => activeConversation.current);
    }).catch(() => {});
    return () => {
      cancelled = true;
      stopNotifications();
    };
  }, [signedIn]);

  const content = () => {
    switch (screen.name) {
      case 'boot':
        return <View style={ui.screen} />;
      case 'loading':
        return (
          <View style={[ui.screen, { alignItems: 'center', justifyContent: 'center' }]}>
            <ActivityIndicator color={colors.accent} />
          </View>
        );
      case 'auth':
        return <AuthScreen onSignedIn={() => setScreen({ name: 'list' })} />;
      case 'list':
        return (
          <ChatListScreen
            onOpen={conversation => setScreen({ name: 'chat', conversation })}
            onSignedOut={() => setScreen({ name: 'auth' })}
          />
        );
      case 'chat':
        return <ChatScreen conversation={screen.conversation} onBack={() => setScreen({ name: 'list' })} />;
    }
  };

  return (
    <SafeAreaProvider>
      <StatusBar barStyle={isDarkMode() ? 'light-content' : 'dark-content'} backgroundColor={colors.bg} />
      {/* key: layar dipasang ulang saat tema berganti agar gaya memakai warna baru */}
      <SafeAreaView key={themeTick} style={ui.screen}>{content()}</SafeAreaView>
    </SafeAreaProvider>
  );
};

export default App;
