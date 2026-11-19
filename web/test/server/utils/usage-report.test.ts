import { describe, expect, it } from 'vitest'
import {
  SUPABASE_FREE_LIMITS,
  appendUsageSection,
  billingCycle,
  buildUsageSection,
  estimateRealtimeMessages,
  nextCronRun,
  type AppLimits,
} from '../../../server/utils/usage-report'

const utc = (y: number, m: number, d: number, h = 0, min = 0) => new Date(Date.UTC(y, m - 1, d, h, min))

describe('billingCycle', () => {
  it('siklus dimulai tiap tanggal 11 dan menghitung sisa hari sampai reset', () => {
    const cycle = billingCycle(utc(2026, 11, 19, 3), 11)
    expect(cycle.start.toISOString()).toBe('2026-11-11T00:00:00.000Z')
    expect(cycle.end.toISOString()).toBe('2026-12-11T00:00:00.000Z')
    expect(cycle.daysLeft).toBe(22)
  })

  it('sebelum tanggal mulai di bulan berjalan, siklus dimulai bulan lalu; pergantian tahun benar', () => {
    const cycle = billingCycle(utc(2027, 1, 5), 11)
    expect(cycle.start.toISOString()).toBe('2026-12-11T00:00:00.000Z')
    expect(cycle.end.toISOString()).toBe('2027-01-11T00:00:00.000Z')
  })

  it('tanggal di atas 28 dibatasi agar ada di tiap bulan', () => {
    expect(billingCycle(utc(2026, 11, 29), 31).start.getUTCDate()).toBe(28)
  })
})

describe('nextCronRun', () => {
  it('Senin dan Kamis 01.00 UTC (08.00 WIB), berikutnya setelah sekarang', () => {
    // Kamis 19 Nov 2026 03.00 UTC sudah lewat 01.00 -> Senin 23 Nov
    expect(nextCronRun(utc(2026, 11, 19, 3)).toISOString()).toBe('2026-11-23T01:00:00.000Z')
    // Rabu 18 Nov -> Kamis 19 Nov
    expect(nextCronRun(utc(2026, 11, 18, 12)).toISOString()).toBe('2026-11-19T01:00:00.000Z')
    // Kamis tepat sebelum 01.00 UTC -> hari itu juga
    expect(nextCronRun(utc(2026, 11, 19, 0, 30)).toISOString()).toBe('2026-11-19T01:00:00.000Z')
  })
})

describe('buildUsageSection', () => {
  const app: AppLimits = {
    maxTextLength: 4000,
    maxFileBytes: 50 * 1024 * 1024,
    pruneAtMb: 400,
    rate: { loggedInPerMinute: 1000, anonymousPerMinute: 50, anonymousAuthPerMinute: 10 },
  }
  const now = utc(2026, 11, 19, 3)
  const base = { now, cycle: billingCycle(now, 11), dbBytes: 34 * 1024 * 1024, app }

  it('memuat siklus, kuota, batas aplikasi, dan jadwal; angka kuota dari database', () => {
    const { text } = buildUsageSection({ ...base, overview: { mau: 5, messages_created: 200, messages_deleted: 20, devices_active: 4 } })
    expect(text).toContain('Kuota direset: 11 Desember 2026 (22 hari lagi)')
    expect(text).toContain('Pengguna aktif bulanan (MAU): 5 / 50.000 (<0,1%)')
    expect(text).toContain('Pesan Realtime (minimal): 640 / 2.000.000')
    expect(text).toContain('Database: 34.0 MB / 512.0 MB (6,6%)')
    expect(text).toContain('1.000/menit per pengguna+IP')
    expect(text).toContain('Senin dan Kamis 08.00 WIB')
  })

  it('tanpa migrasi: angka dari database ditandai belum tersedia, sisanya tetap ada', () => {
    const { text } = buildUsageSection({ ...base, overview: null })
    expect(text).toContain('MAU): belum tersedia (jalankan migrasi seru24_usage_overview)')
    expect(text).toContain('Database: 34.0 MB')
  })

  it('perkiraan pesan Realtime = 3 x dibuat + 2 x dihapus', () => {
    expect(estimateRealtimeMessages({ mau: 0, messages_created: 10, messages_deleted: 5, devices_active: 0 })).toBe(40)
  })

  it('kuota Free sesuai dashboard dan teks di HTML di-escape', () => {
    expect(SUPABASE_FREE_LIMITS.realtimeMessages).toBe(2_000_000)
    const { html } = buildUsageSection({ ...base, overview: null })
    expect(html).not.toContain('<script')
  })
})

describe('appendUsageSection', () => {
  const usage = { text: 'KUOTA', html: '<p>KUOTA</p>' }

  it('teks ditambah di akhir dan HTML disisipkan sebelum footer', () => {
    const mail = { subject: 's', text: 'rekap', html: '<div>isi</div><div style="background:#f8fafc;padding:10px">footer</div>' }
    const result = appendUsageSection(mail, usage)
    expect(result.text).toBe('rekap\n\nKUOTA')
    expect(result.html).toBe('<div>isi</div><p>KUOTA</p><div style="background:#f8fafc;padding:10px">footer</div>')
    expect(result.subject).toBe('s')
  })

  it('tanpa footer: HTML ditambah di akhir', () => {
    expect(appendUsageSection({ text: 'a', html: '<div>x</div>' }, usage).html).toBe('<div>x</div><p>KUOTA</p>')
  })
})
