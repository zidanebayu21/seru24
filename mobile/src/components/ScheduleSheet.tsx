import React, { useMemo, useState } from 'react';
import { Modal, Pressable, Text, TextInput, View } from 'react-native';
import { formatScheduleTime, parseClockInput, schedulePresets } from '../../../web/shared/schedule-core';
import { colors, themed, ui } from '../theme';

interface Props {
  open: boolean;
  busy: boolean;
  error: string;
  onClose: () => void;
  onPick: (at: Date) => void;
  onInvalid: (message: string) => void;
}

/** Pilihan waktu kirim terjadwal: pilihan cepat atau jam yang diketik (hari ini bila belum lewat, selain itu besok). */
export const ScheduleSheet = ({ open, busy, error, onClose, onPick, onInvalid }: Props) => {
  const [clock, setClock] = useState('');
  // dihitung ulang tiap sheet dibuka agar "dalam 1 jam" dan "nanti malam" mengikuti waktu sekarang
  const presets = useMemo(() => (open ? schedulePresets(new Date()) : []), [open]);

  const submitClock = () => {
    const at = parseClockInput(clock, new Date());
    if (at) onPick(at);
    else onInvalid('Tulis jam seperti 20.30');
  };

  return (
    <Modal transparent visible={open} animationType="fade" onRequestClose={onClose}>
      <Pressable style={styles.backdrop} onPress={onClose}>
        <Pressable style={styles.card} onPress={() => undefined}>
          <Text style={styles.title}>Jadwalkan pesan</Text>
          <Text style={ui.muted}>Pesan tetap terenkripsi; server hanya menyimpannya sampai waktu kirim.</Text>
          {presets.map(preset => (
            <Pressable
              key={preset.label}
              accessibilityRole="button"
              disabled={busy}
              onPress={() => onPick(preset.at)}
              style={[styles.preset, { opacity: busy ? 0.5 : 1 }]}>
              <Text style={{ color: colors.text, fontWeight: '600' }}>{preset.label}</Text>
              <Text style={ui.muted}>{formatScheduleTime(preset.at.toISOString(), new Date())}</Text>
            </Pressable>
          ))}
          <View style={ui.row}>
            <TextInput
              style={[ui.input, { flex: 1 }]}
              value={clock}
              onChangeText={setClock}
              placeholder="Atau ketik jam, mis. 20.30"
              placeholderTextColor={colors.muted}
              keyboardType="numbers-and-punctuation"
              returnKeyType="done"
              onSubmitEditing={submitClock}
              maxLength={5}
            />
            <Pressable accessibilityRole="button" disabled={busy} onPress={submitClock} style={styles.set}>
              <Text style={{ color: colors.accentText, fontWeight: '700' }}>Atur</Text>
            </Pressable>
          </View>
          {error ? <Text style={{ color: colors.danger }}>{error}</Text> : null}
          <Pressable accessibilityRole="button" onPress={onClose} style={{ alignSelf: 'flex-end', padding: 6 }}>
            <Text style={{ color: colors.muted, fontWeight: '600' }}>Batal</Text>
          </Pressable>
        </Pressable>
      </Pressable>
    </Modal>
  );
};

const styles = themed(() => ({
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.35)', justifyContent: 'center', padding: 20 },
  card: { gap: 10, padding: 18, borderRadius: 18, backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border },
  title: { fontSize: 18, fontWeight: '700', color: colors.text },
  preset: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    gap: 10,
    padding: 12,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: colors.border,
  },
  set: { paddingHorizontal: 16, paddingVertical: 11, borderRadius: 12, backgroundColor: colors.accent },
}));
