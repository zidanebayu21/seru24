import { THEME_OPTIONS, isThemePref, resolveTheme, type ThemePref } from '#shared/theme-core'

const STORAGE_KEY = 'seru24:theme'

// Preferensi tampilan saja (bukan rahasia), jadi cukup di localStorage perangkat ini.
const readPref = (): ThemePref => {
  try {
    const stored = localStorage.getItem(STORAGE_KEY)
    return isThemePref(stored) ? stored : 'system'
  } catch {
    return 'system'
  }
}

export const useTheme = () => {
  const pref = useState<ThemePref>('theme-pref', () => 'system')

  const apply = () => {
    const systemDark = window.matchMedia('(prefers-color-scheme: dark)').matches
    document.documentElement.dataset.theme = resolveTheme(pref.value, systemDark)
  }

  /** Dipanggil sekali di client: baca pilihan tersimpan dan ikuti perubahan tema sistem. */
  const init = () => {
    pref.value = readPref()
    apply()
    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', apply)
  }

  const setTheme = (value: ThemePref) => {
    pref.value = value
    try {
      localStorage.setItem(STORAGE_KEY, value)
    } catch {
      // penyimpanan diblokir: tema tetap berlaku selama halaman terbuka
    }
    apply()
  }

  return { pref, options: THEME_OPTIONS, init, setTheme }
}
