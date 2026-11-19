import { describe, expect, it } from 'vitest'
import {
  formatScheduleTime,
  fromLocalInputValue,
  parseClockInput,
  schedulePresets,
  scheduledAsMessage,
  scheduledFailureText,
  toLocalInputValue,
  toScheduleParams,
  validateScheduleTime,
  type ScheduledRow,
} from '../../shared/schedule-core'

// semua tanggal dibuat dengan konstruktor lokal agar tes tidak bergantung pada zona waktu mesin
const local = (y: number, m: number, d: number, h = 0, min = 0) => new Date(y, m - 1, d, h, min, 0, 0)

describe('schedulePresets', () => {
  it('siang hari: 1 jam lagi, malam ini, besok pagi, dan Senin', () => {
    // Kamis 19 Nov 2026 14.00
    const presets = schedulePresets(local(2026, 11, 19, 14))
    expect(presets.map((p) => p.label)).toEqual(['Dalam 1 jam', 'Nanti malam 20.00', 'Besok pagi 08.00', 'Senin 08.00'])
    expect(presets[1]!.at).toEqual(local(2026, 11, 19, 20))
    expect(presets[3]!.at).toEqual(local(2026, 11, 23, 8))
  })

  it('malam hari: pilihan "nanti malam" dilewati karena sudah dekat atau lewat', () => {
    const labels = schedulePresets(local(2026, 11, 19, 19, 30)).map((p) => p.label)
    expect(labels).not.toContain('Nanti malam 20.00')
  })

  it('Minggu: Senin sama dengan besok sehingga tidak dobel', () => {
    // Minggu 22 Nov 2026
    const labels = schedulePresets(local(2026, 11, 22, 10)).map((p) => p.label)
    expect(labels).toContain('Besok pagi 08.00')
    expect(labels).not.toContain('Senin 08.00')
  })
})

describe('validateScheduleTime', () => {
  const now = local(2026, 11, 19, 12)
  it('menolak waktu terlalu dekat atau lewat, dan terlalu jauh', () => {
    expect(validateScheduleTime(local(2026, 11, 19, 12), now)).toBe('too_soon')
    expect(validateScheduleTime(new Date(now.getTime() + 30_000), now)).toBe('too_soon')
    expect(validateScheduleTime(local(2026, 12, 25, 12), now)).toBe('too_far')
    expect(validateScheduleTime(new Date(Number.NaN), now)).toBe('too_soon')
  })
  it('menerima waktu di antara 1 menit dan 30 hari', () => {
    expect(validateScheduleTime(new Date(now.getTime() + 61_000), now)).toBeNull()
    expect(validateScheduleTime(local(2026, 12, 18, 12), now)).toBeNull()
  })
})

describe('parseClockInput', () => {
  const now = local(2026, 11, 19, 14)
  it('jam yang belum lewat = hari ini, yang sudah lewat = besok', () => {
    expect(parseClockInput('20.30', now)).toEqual(local(2026, 11, 19, 20, 30))
    expect(parseClockInput('9', now)).toEqual(local(2026, 11, 20, 9))
    expect(parseClockInput(' 07:05 ', now)).toEqual(local(2026, 11, 20, 7, 5))
  })
  it('menolak format atau nilai yang salah', () => {
    for (const bad of ['', 'abc', '24.00', '12.60', '1:2', '12.5']) expect(parseClockInput(bad, now)).toBeNull()
  })
})

describe('input datetime-local', () => {
  it('bolak-balik tanpa bergeser', () => {
    const date = local(2026, 3, 5, 7, 9)
    expect(toLocalInputValue(date)).toBe('2026-03-05T07:09')
    expect(fromLocalInputValue('2026-03-05T07:09')).toEqual(date)
  })
  it('nilai kosong atau rusak = null', () => {
    expect(fromLocalInputValue('')).toBeNull()
    expect(fromLocalInputValue('besok')).toBeNull()
  })
})

describe('formatScheduleTime', () => {
  const now = local(2026, 11, 19, 14)
  it('hari ini, besok, dan tanggal lain', () => {
    expect(formatScheduleTime(local(2026, 11, 19, 20).toISOString(), now)).toBe('Hari ini 20.00')
    expect(formatScheduleTime(local(2026, 11, 20, 8, 5).toISOString(), now)).toBe('Besok 08.05')
    expect(formatScheduleTime(local(2026, 11, 23, 8).toISOString(), now)).toMatch(/23.*08\.00$/)
  })
})

describe('toScheduleParams dan scheduledAsMessage', () => {
  const sealed = {
    p_conversation_id: 'c1',
    p_client_msg_id: 'm1',
    p_kind: 'text',
    p_ciphertext: 'CT',
    p_nonce: 'N',
    p_sender_key_version: 2,
    p_recipient_key_version: 3,
  }
  it('tidak mengirim jenis pesan dan memakai waktu ISO (UTC)', () => {
    const at = local(2026, 11, 20, 8)
    const params = toScheduleParams(sealed, at, 'r1')
    expect(params).not.toHaveProperty('p_kind')
    expect(params.p_send_at).toBe(at.toISOString())
    expect(params.p_reply_to).toBe('r1')
  })

  it('baris terjadwal dipetakan ke bentuk pesan milik pengirim', () => {
    const row: ScheduledRow = {
      id: 's1', client_msg_id: 'm1', ciphertext: 'CT', nonce: 'N', sender_key_version: 2, recipient_key_version: 3,
      send_at: '2026-11-20T01:00:00Z', status: 'pending', error_code: null,
    }
    const message = scheduledAsMessage(row, 'c1', 'me')
    expect(message).toMatchObject({ sender_id: 'me', conversation_id: 'c1', kind: 'text', ciphertext: 'CT', deleted_at: null })
  })
})

describe('scheduledFailureText', () => {
  it('kode dikenal dan tidak dikenal', () => {
    expect(scheduledFailureText({ error_code: 'stale_key' })).toContain('Kunci')
    expect(scheduledFailureText({ error_code: null })).toBe('Pesan terjadwal gagal dikirim.')
  })
})
