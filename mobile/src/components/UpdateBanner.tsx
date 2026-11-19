import React, { useEffect, useState } from 'react';
import { Linking, Pressable, Text, View } from 'react-native';
import type { AppRelease } from '../../../web/shared/app-release';
import { formatFileSize } from '../../../web/shared/file-core';
import { checkForUpdate, installUpdate } from '../lib/update';
import { colors, ui } from '../theme';
import { Button } from './Button';

/** Peringatan versi baru: unduh dan pasang dari dalam aplikasi, atau buka link Google Drive yang sama. */
export const UpdateBanner = () => {
  const [release, setRelease] = useState<AppRelease | null>(null);
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let alive = true;
    checkForUpdate().then(found => {
      if (alive) setRelease(found);
    });
    return () => {
      alive = false;
    };
  }, []);

  if (!release) return null;

  const update = async () => {
    setBusy(true);
    setStatus('Mengunduh…');
    try {
      const result = await installUpdate(release, (done, total) =>
        setStatus(total > 0 ? `Mengunduh ${Math.round((done / total) * 100)}%` : `Mengunduh ${formatFileSize(done)}`),
      );
      setStatus(
        result === 'need_permission'
          ? 'Izinkan "Instal aplikasi tak dikenal" untuk seru24, lalu ketuk Perbarui lagi.'
          : result === 'unsupported'
            ? 'Pembaruan langsung tidak didukung; unduh lewat link.'
            : 'Sudah diunduh. Ikuti layar instal; bila tertunda peringatan Play Protect, ketuk Perbarui lagi (tanpa unduh ulang).',
      );
    } catch {
      setStatus('Pembaruan gagal. Coba lagi atau unduh lewat link.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <View style={[ui.notice, { gap: 8 }]}>
      <Text style={{ color: colors.text }}>
        Versi baru {release.versionName} tersedia{release.sizeBytes ? ` (${formatFileSize(release.sizeBytes)})` : ''}.
      </Text>
      {status ? <Text style={[ui.muted, { fontSize: 12 }]}>{status}</Text> : null}
      <View style={[ui.row, { gap: 12 }]}>
        <Button label="Perbarui" onPress={update} busy={busy} />
        <Pressable accessibilityRole="link" onPress={() => Linking.openURL(release.url)}>
          <Text style={{ color: colors.accent, textDecorationLine: 'underline' }}>Buka di Google Drive</Text>
        </Pressable>
      </View>
    </View>
  );
};
