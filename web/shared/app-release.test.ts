import { describe, expect, it } from 'vitest'
import { driveLinks, isNewerRelease, parseAppRelease } from './app-release'

const release = {
  versionCode: 6,
  versionName: '1.6',
  ...driveLinks('1AbCdEfGhIjKlMnOp_qrs-TUV'),
  sha256: 'a'.repeat(64),
  sizeBytes: 10_000_000,
  updatedAt: '2026-11-18T08:00:00.000Z',
}

describe('app-release', () => {
  it('menerima info rilis yang valid', () => {
    expect(parseAppRelease(release)).toEqual(release)
  })

  it('menolak link selain Google Drive dan data yang rusak', () => {
    expect(parseAppRelease({ ...release, url: 'https://evil.example/seru24.apk' })).toBeNull()
    expect(parseAppRelease({ ...release, url: 'javascript:alert(1)' })).toBeNull()
    expect(parseAppRelease({ ...release, downloadUrl: 'https://evil.example/download?id=x' })).toBeNull()
    expect(parseAppRelease({ ...release, sha256: 'bukan-hash' })).toBeNull()
    expect(parseAppRelease({ ...release, versionCode: 0 })).toBeNull()
    expect(parseAppRelease({ ...release, versionName: '<b>1.6</b>' })).toBeNull()
    expect(parseAppRelease(null)).toBeNull()
  })

  it('hanya memberi tahu bila versi di server lebih baru', () => {
    expect(isNewerRelease(release, 5)).toBe(true)
    expect(isNewerRelease(release, 6)).toBe(false)
    expect(isNewerRelease(release, 7)).toBe(false)
    expect(isNewerRelease(null, 1)).toBe(false)
  })
})
