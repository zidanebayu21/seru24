const mockSettings = new Map<string, string>();

jest.mock('../src/lib/core', () => ({
  readSetting: jest.fn(async (k: string) => mockSettings.get(k) ?? null),
  writeSetting: jest.fn(async (k: string, v: string) => { mockSettings.set(k, v); }),
}));

import {
  colors,
  isDarkMode,
  loadTheme,
  onThemeChange,
  setTheme,
  themePref,
  themeVersion,
  themed,
  ui,
} from '../src/theme';

describe('mobile theme', () => {
  it('memuat tema dari setting dan mendeteksi perubahan tema', async () => {
    mockSettings.set('theme', 'dark');
    await loadTheme();

    expect(themePref()).toBe('dark');
    expect(isDarkMode()).toBe(true);
    expect(colors.bg).toBe('#0f1215');

    let changed = 0;
    const unsub = onThemeChange(() => {
      changed++;
    });

    await setTheme('light');
    expect(themePref()).toBe('light');
    expect(isDarkMode()).toBe(false);
    expect(colors.bg).toBe('#f4f5f7');
    expect(changed).toBe(1);

    const testThemed = themed(() => ({
      box: { backgroundColor: colors.bg },
    }));
    expect(testThemed.box.backgroundColor).toBe('#f4f5f7');
    expect(ui.screen.backgroundColor).toBe('#f4f5f7');

    await setTheme('brown');
    expect(testThemed.box.backgroundColor).toBe('#13100e');
    expect(ui.screen.backgroundColor).toBe('#13100e');

    unsub();
  });
});
