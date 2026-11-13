import React, { useEffect, useState } from 'react';
import { ActivityIndicator, StatusBar, View } from 'react-native';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import type { Conversation } from '../../web/shared/chat-core';
import { restoreSession } from './lib/core';
import { AuthScreen } from './screens/AuthScreen';
import { ChatListScreen } from './screens/ChatListScreen';
import { ChatScreen } from './screens/ChatScreen';
import { colors, ui } from './theme';

type Screen = { name: 'loading' } | { name: 'auth' } | { name: 'list' } | { name: 'chat'; conversation: Conversation };

const App = () => {
  const [screen, setScreen] = useState<Screen>({ name: 'loading' });

  useEffect(() => {
    restoreSession()
      .then(status => setScreen(status === 'ready' ? { name: 'list' } : { name: 'auth' }))
      .catch(() => setScreen({ name: 'auth' }));
  }, []);

  const content = () => {
    switch (screen.name) {
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
      <StatusBar barStyle="dark-content" backgroundColor={colors.bg} />
      <SafeAreaView style={ui.screen}>{content()}</SafeAreaView>
    </SafeAreaProvider>
  );
};

export default App;
