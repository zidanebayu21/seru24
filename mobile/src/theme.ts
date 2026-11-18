import { Appearance, StyleSheet, type ImageStyle, type TextStyle, type ViewStyle } from 'react-native';
import { PALETTES, isDarkTheme, isThemePref, resolveTheme, type Palette, type ThemeName, type ThemePref } from '../../web/shared/theme-core';
import { readSetting, writeSetting } from './lib/core';

// `colors` diubah di tempat saat tema berganti; gaya dibuat ulang lewat `themed` dan App memasang ulang layar
// (key = themeVersion), jadi komponen cukup membaca `colors.x` saat render.
export const colors: Palette = { ...PALETTES.light };

const SETTING = 'theme';
let pref: ThemePref = 'system';
let current: ThemeName = 'light';
let version = 0;
const listeners = new Set<() => void>();

const apply = () => {
  const next = resolveTheme(pref, Appearance.getColorScheme() === 'dark');
  if (next === current && version > 0) return;
  current = next;
  Object.assign(colors, PALETTES[next]);
  version += 1;
  for (const listener of listeners) listener();
};

export const themeVersion = () => version;
export const themePref = () => pref;
export const isDarkMode = () => isDarkTheme(current);
export const onThemeChange = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

export const loadTheme = async () => {
  const stored = await readSetting(SETTING);
  pref = isThemePref(stored) ? stored : 'system';
  apply();
  Appearance.addChangeListener(apply);
};

export const setTheme = async (value: ThemePref) => {
  pref = value;
  apply();
  await writeSetting(SETTING, value);
};

type NamedStyles<T> = { [P in keyof T]: ViewStyle | TextStyle | ImageStyle };

/** Gaya yang ikut tema: dibuat ulang bila tema berubah sejak terakhir dibaca. */
export const themed = <T extends NamedStyles<T> | NamedStyles<any>>(
  factory: () => T | NamedStyles<T>,
): T => {
  let built = -1;
  let cache: T;
  return new Proxy({} as T, {
    get: (_, key) => {
      if (built !== version) {
        cache = StyleSheet.create(factory()) as T;
        built = version;
      }
      return cache[key as keyof T];
    },
  });
};

export const ui = themed(() => ({
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
}));
