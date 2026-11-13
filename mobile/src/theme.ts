import { StyleSheet } from 'react-native';

export const colors = {
  bg: '#f4f5f7',
  surface: '#ffffff',
  text: '#1c1f24',
  muted: '#646b75',
  border: '#dde1e6',
  accent: '#0f766e',
  accentText: '#ffffff',
  mine: '#d9f2ee',
  danger: '#b42318',
  warnBg: '#fff4d6',
};

export const ui = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  card: {
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: 12,
    padding: 16,
    gap: 12,
  },
  title: { fontSize: 22, fontWeight: '700', color: colors.text },
  brand: { color: colors.accent, fontWeight: '700', fontSize: 18 },
  label: { color: colors.muted, fontSize: 13, marginBottom: 4 },
  input: {
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    color: colors.text,
    backgroundColor: colors.surface,
  },
  button: { borderRadius: 8, paddingVertical: 12, paddingHorizontal: 14, alignItems: 'center' },
  primary: { backgroundColor: colors.accent },
  primaryText: { color: colors.accentText, fontWeight: '600' },
  plain: { backgroundColor: colors.surface, borderColor: colors.border, borderWidth: 1 },
  plainText: { color: colors.text },
  muted: { color: colors.muted, fontSize: 13 },
  error: { color: colors.danger, fontSize: 14 },
  notice: { backgroundColor: colors.warnBg, borderRadius: 8, padding: 10, color: colors.text, fontSize: 13 },
  link: { color: colors.accent, fontWeight: '600' },
  row: { flexDirection: 'row', alignItems: 'center', gap: 8 },
});
