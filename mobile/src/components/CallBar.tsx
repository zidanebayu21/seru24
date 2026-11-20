import React from 'react';
import { Text, View } from 'react-native';
import { colors, themed, ui } from '../theme';
import { Button } from './Button';
import type { VoiceCall } from '../lib/useVoiceCall';

const TITLES: Record<string, string> = {
  calling: 'Memanggil…',
  incoming: 'Panggilan suara masuk',
  connecting: 'Menyambungkan…',
  connected: 'Sedang berbicara',
};

/** Bar panggilan suara di bawah header chat; saat tidak ada panggilan hanya menampilkan catatan singkat hasil terakhir. */
export const CallBar = ({ call }: { call: VoiceCall }) => {
  if (call.phase === 'idle') {
    return call.note ? <Text style={[ui.muted, styles.note]} accessibilityLiveRegion="polite">{call.note}</Text> : null;
  }
  return (
    <View style={styles.bar} accessibilityLiveRegion="polite">
      <Text style={{ fontWeight: '700', color: colors.text }}>{TITLES[call.phase]}</Text>
      <View style={ui.row}>
        {call.phase === 'incoming' ? <Button label="Terima" onPress={call.accept} /> : null}
        {call.phase === 'incoming' ? <Button label="Tolak" variant="danger" onPress={call.reject} /> : null}
        {call.phase === 'connected' ? <Button label={call.muted ? 'Bunyikan' : 'Bisukan'} variant="plain" onPress={call.toggleMute} /> : null}
        {call.phase === 'connected' ? <Button label={call.speaker ? 'Earpiece' : 'Speaker'} variant="plain" onPress={call.toggleSpeaker} /> : null}
        {call.phase !== 'incoming' ? <Button label="Akhiri" variant="danger" onPress={call.hangup} /> : null}
      </View>
      {call.peerRecording ? <Text style={styles.rec}>Lawan bicara sedang merekam panggilan ini</Text> : null}
    </View>
  );
};

const styles = themed(() => ({
  bar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    flexWrap: 'wrap',
    gap: 8,
    padding: 12,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
    backgroundColor: colors.surface,
  },
  note: { textAlign: 'center', paddingVertical: 6 },
  rec: { flexBasis: '100%', color: colors.danger, fontSize: 12 },
}));
