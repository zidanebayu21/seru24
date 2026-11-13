import React, { useState } from 'react';
import { KeyboardAvoidingView, Linking, Platform, Pressable, ScrollView, Text, TextInput, View } from 'react-native';
import { errorMessage } from '../../../web/shared/secure-fetch-core';
import { finishSignIn, session, signOut, webUrl } from '../lib/core';
import { Button } from '../components/Button';
import { PASSWORD_MIN_LENGTH as PASSWORD_MIN } from '../env';
import { ui } from '../theme';

const USERNAME_PATTERN = /^[a-z0-9_]{3,30}$/;

interface Props {
  onSignedIn: () => void;
}

export const AuthScreen = ({ onSignedIn }: Props) => {
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [identifier, setIdentifier] = useState('');
  const [email, setEmail] = useState('');
  const [username, setUsername] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);

  const isLogin = mode === 'login';

  const validateRegister = () => {
    if (!USERNAME_PATTERN.test(username)) return 'Username 3-30 karakter: huruf kecil, angka, atau _';
    if (password.length < PASSWORD_MIN) return `Password minimal ${PASSWORD_MIN} karakter`;
    if (password !== confirm) return 'Konfirmasi password tidak sama';
    return '';
  };

  const submit = async () => {
    setError('');
    setNotice('');
    if (!isLogin) {
      const invalid = validateRegister();
      if (invalid) {
        setError(invalid);
        return;
      }
    }
    setBusy(true);
    try {
      if (isLogin) {
        await session.loginWithPassword(identifier.trim().toLowerCase(), password);
      } else {
        const status = await session.registerAccount({ email: email.trim(), username, display_name: displayName.trim(), password });
        if (status === 'verify_email') {
          setNotice('Tautan verifikasi dikirim ke email. Buka tautan itu, lalu masuk.');
          setMode('login');
          return;
        }
      }
    } catch (e) {
      setError(errorMessage(e, isLogin ? 'Login gagal. Coba lagi.' : 'Pendaftaran gagal. Coba lagi.'));
      return;
    } finally {
      setBusy(false);
    }

    setBusy(true);
    try {
      await finishSignIn();
      onSignedIn();
    } catch {
      await signOut();
      setError('Masuk berhasil, tetapi kunci chat tidak bisa dibuka. Coba lagi.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <KeyboardAvoidingView style={ui.screen} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <ScrollView contentContainerStyle={{ flexGrow: 1, justifyContent: 'center', padding: 16 }} keyboardShouldPersistTaps="handled">
        <View style={ui.card}>
          <Text style={ui.brand}>seru24</Text>
          <Text style={ui.title}>{isLogin ? 'Masuk' : 'Daftar'}</Text>
          <Text style={ui.muted}>Chat terenkripsi end-to-end</Text>
          {notice ? <Text style={ui.notice}>{notice}</Text> : null}

          {isLogin ? (
            <Field label="Email atau username" value={identifier} onChange={setIdentifier} autoComplete="username" />
          ) : (
            <>
              <Field label="Email" value={email} onChange={setEmail} autoComplete="email" keyboardType="email-address" />
              <Field label="Username" value={username} onChange={v => setUsername(v.toLowerCase())} placeholder="mis. zidane_21" />
              <Field label="Nama tampil" value={displayName} onChange={setDisplayName} autoComplete="name" autoCapitalize="words" />
            </>
          )}
          <Field label="Password" value={password} onChange={setPassword} secure autoComplete={isLogin ? 'password' : 'password-new'} />
          {!isLogin && (
            <>
              <Field label="Ulangi password" value={confirm} onChange={setConfirm} secure autoComplete="password-new" />
              <Text style={ui.notice}>
                Password ini juga membuka pesan terenkripsi Anda dan tidak pernah dikirim ke server. Jika lupa password,
                pesan lama tidak bisa dibuka lagi.
              </Text>
            </>
          )}

          {error ? <Text style={ui.error}>{error}</Text> : null}
          <Button label={isLogin ? 'Masuk' : 'Daftar'} onPress={submit} busy={busy} />
          {busy ? <Text style={ui.muted}>Mengamankan kunci, mohon tunggu…</Text> : null}

          <View style={[ui.row, { flexWrap: 'wrap' }]}>
            {isLogin && (
              <Pressable onPress={() => Linking.openURL(webUrl('/lupa-password'))}>
                <Text style={ui.link}>Lupa password?</Text>
              </Pressable>
            )}
            <Pressable onPress={() => { setMode(isLogin ? 'register' : 'login'); setError(''); }}>
              <Text style={ui.link}>{isLogin ? 'Belum punya akun? Daftar' : 'Sudah punya akun? Masuk'}</Text>
            </Pressable>
          </View>
        </View>
      </ScrollView>
    </KeyboardAvoidingView>
  );
};

interface FieldProps {
  label: string;
  value: string;
  onChange: (value: string) => void;
  secure?: boolean;
  placeholder?: string;
  autoComplete?: 'username' | 'email' | 'name' | 'password' | 'password-new';
  autoCapitalize?: 'none' | 'words';
  keyboardType?: 'default' | 'email-address';
}

const Field = ({ label, value, onChange, secure, placeholder, autoComplete, autoCapitalize = 'none', keyboardType = 'default' }: FieldProps) => (
  <View>
    <Text style={ui.label}>{label}</Text>
    <TextInput
      style={ui.input}
      value={value}
      onChangeText={onChange}
      secureTextEntry={secure}
      placeholder={placeholder}
      autoComplete={autoComplete}
      autoCapitalize={autoCapitalize}
      autoCorrect={false}
      keyboardType={keyboardType}
      maxLength={secure ? 128 : 254}
    />
  </View>
);
