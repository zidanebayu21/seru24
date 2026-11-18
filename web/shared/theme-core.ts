// Tema tampilan bersama web dan mobile. Palet ini juga ada di web/app/assets/main.css (variabel CSS);
// theme-core.test.ts memastikan keduanya tidak berbeda.

export type ThemeName = 'light' | 'dark' | 'teal'
export type ThemePref = 'system' | ThemeName

export interface Palette {
  bg: string
  surface: string
  text: string
  muted: string
  border: string
  accent: string
  accentText: string
  mine: string
  danger: string
  warnBg: string
}

export const PALETTES: Record<ThemeName, Palette> = {
  light: {
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
  },
  dark: {
    bg: '#0f1215',
    surface: '#181c21',
    text: '#e7e9ec',
    muted: '#9aa1aa',
    border: '#2a3038',
    accent: '#2dd4bf',
    accentText: '#062a26',
    mine: '#123a35',
    danger: '#f97066',
    warnBg: '#3a2f12',
  },
  // coklat tua hangat dengan aksen teal
  teal: {
    bg: '#1d1612',
    surface: '#2a201a',
    text: '#f2e8dd',
    muted: '#b5a392',
    border: '#44342b',
    accent: '#2ec4b0',
    accentText: '#06231f',
    mine: '#1d4a44',
    danger: '#ff8a7a',
    warnBg: '#4a3a1c',
  },
}

export const THEME_OPTIONS: { value: ThemePref; label: string }[] = [
  { value: 'system', label: 'Ikuti sistem' },
  { value: 'light', label: 'Terang' },
  { value: 'dark', label: 'Gelap' },
  { value: 'teal', label: 'Coklat teal' },
]

export const isThemePref = (value: unknown): value is ThemePref =>
  THEME_OPTIONS.some((option) => option.value === value)

/** Tema yang dipakai: pilihan pengguna, atau mengikuti sistem bila 'system'. */
export const resolveTheme = (pref: ThemePref, systemDark: boolean): ThemeName =>
  pref === 'system' ? (systemDark ? 'dark' : 'light') : pref

/** Tema gelap = teks terang di latar gelap (status bar, color-scheme). */
export const isDarkTheme = (theme: ThemeName) => theme !== 'light'
