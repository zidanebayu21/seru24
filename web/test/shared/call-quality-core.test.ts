import { describe, expect, it } from 'vitest'
import {
  CALL_QUALITIES,
  DEFAULT_CALL_QUALITY,
  callQualityKey,
  callQualityOption,
  nextCallQuality,
  parseCallQuality,
} from '../../shared/call-quality-core'

describe('call-quality-core', () => {
  it('menyediakan 16, 32, 64, dan 128 kbps dengan bawaan 32 kbps', () => {
    expect(CALL_QUALITIES.map((o) => o.bitrate)).toEqual([16_000, 32_000, 64_000, 128_000])
    expect(callQualityOption(DEFAULT_CALL_QUALITY).bitrate).toBe(32_000)
  })

  it('nilai tersimpan yang tidak dikenal kembali ke bawaan', () => {
    expect(parseCallQuality('studio')).toBe('studio')
    expect(parseCallQuality('aneh')).toBe('standar')
    expect(parseCallQuality(null)).toBe('standar')
    expect(parseCallQuality(undefined)).toBe('standar')
  })

  it('berganti berputar dari hemat ke studio lalu kembali', () => {
    expect(nextCallQuality('hemat')).toBe('standar')
    expect(nextCallQuality('tinggi')).toBe('studio')
    expect(nextCallQuality('studio')).toBe('hemat')
  })

  it('kunci penyimpanan berbeda untuk tiap percakapan', () => {
    expect(callQualityKey('a')).not.toBe(callQualityKey('b'))
  })
})
