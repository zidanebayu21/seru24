import { describe, expect, it, vi } from 'vitest'
import { loadAutoRecord, pickRecorderMime, recordingFileName, saveAutoRecord } from '../../shared/call-record-core'

describe('call-record-core', () => {
  it('memilih format rekaman pertama yang didukung', () => {
    expect(pickRecorderMime((m) => m === 'audio/ogg;codecs=opus')).toBe('audio/ogg;codecs=opus')
    expect(pickRecorderMime(() => true)).toBe('audio/webm;codecs=opus')
    expect(pickRecorderMime(() => false)).toBeUndefined()
  })

  it('membuat nama berkas aman dengan ekstensi sesuai format', () => {
    const date = new Date(2026, 10, 20, 9, 5, 7)
    expect(recordingFileName('Budi_Santoso', 'audio/webm;codecs=opus', date)).toBe('panggilan-budi_santoso-20261120-090507.webm')
    expect(recordingFileName('../../etc/passwd', 'audio/ogg', date)).toBe('panggilan-etc-passwd-20261120-090507.ogg')
    expect(recordingFileName('', 'audio/mp4', date)).toBe('panggilan-lawan-20261120-090507.m4a')
  })

  it('menyimpan pengaturan rekam otomatis dan tahan storage yang error', () => {
    const store = new Map<string, string>()
    const storage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) }
    expect(loadAutoRecord(storage)).toBe(false)
    saveAutoRecord(storage, true)
    expect(loadAutoRecord(storage)).toBe(true)
    saveAutoRecord(storage, false)
    expect(loadAutoRecord(storage)).toBe(false)

    const broken = { getItem: vi.fn(() => { throw new Error('blocked') }), setItem: vi.fn(() => { throw new Error('blocked') }) }
    expect(loadAutoRecord(broken)).toBe(false)
    expect(() => saveAutoRecord(broken, true)).not.toThrow()
    expect(loadAutoRecord(undefined)).toBe(false)
  })
})
