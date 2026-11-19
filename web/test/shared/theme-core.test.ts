import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { PALETTES, isThemePref, resolveTheme, type Palette, type ThemeName } from '../../shared/theme-core'

const css = readFileSync(new URL('../../app/assets/main.css', import.meta.url), 'utf8')

const CSS_VARS: Record<keyof Palette, string> = {
  bg: '--bg',
  surface: '--surface',
  text: '--text',
  muted: '--muted',
  border: '--border',
  accent: '--accent',
  accentText: '--accent-text',
  mine: '--mine',
  danger: '--danger',
  warnBg: '--warn-bg',
}

/** Isi blok CSS `:root[data-theme="<name>"] { ... }`. */
const themeBlock = (name: ThemeName) => {
  const match = css.match(new RegExp(String.raw`:root\[data-theme="${name}"\]\s*\{([^}]*)\}`))
  if (!match) throw new Error(`blok tema ${name} tidak ada di main.css`)
  return match[1]!
}

describe('theme-core', () => {
  it('mengikuti sistem hanya untuk pilihan system', () => {
    expect(resolveTheme('system', true)).toBe('dark')
    expect(resolveTheme('system', false)).toBe('light')
    expect(resolveTheme('brown', false)).toBe('brown')
    expect(resolveTheme('light', true)).toBe('light')
  })

  it('menolak nilai pilihan yang tidak dikenal', () => {
    expect(isThemePref('brown')).toBe(true)
    expect(isThemePref('merah')).toBe(false)
    expect(isThemePref(null)).toBe(false)
  })

  it.each(Object.keys(PALETTES) as ThemeName[])('palet %s sama dengan main.css', (name) => {
    const block = themeBlock(name)
    for (const [key, variable] of Object.entries(CSS_VARS)) {
      const value = PALETTES[name][key as keyof Palette]
      expect(block, `${name} ${variable}`).toContain(`${variable}: ${value};`)
    }
  })
})
