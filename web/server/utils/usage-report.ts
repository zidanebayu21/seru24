// Bagian "kuota dan batas" di email cron: siklus tagihan Supabase, pemakaian terhadap kuota paket Free, batas aplikasi,
// dan jadwal email berikutnya. Fungsi murni (tanpa akses jaringan) agar mudah diuji.

/** Kuota paket Free Supabase (sama dengan halaman Usage di dashboard). */
export const SUPABASE_FREE_LIMITS = {
  databaseBytes: 0.5 * 1024 ** 3,
  realtimeMessages: 2_000_000,
  realtimePeakConnections: 200,
  mau: 50_000,
  egressGb: 5,
  storageGb: 1,
  logIngestionGb: 1,
  edgeFunctionInvocations: 500_000,
}

/** Hasil fungsi database seru24_usage_overview (dihitung sejak awal siklus tagihan). */
export interface UsageOverview {
  mau: number
  messages_created: number
  messages_deleted: number
  devices_active: number
}

export interface AppLimits {
  maxTextLength: number
  maxFileBytes: number
  /** Batas pemangkasan otomatis database (MB). */
  pruneAtMb: number
  rate: { loggedInPerMinute: number; anonymousPerMinute: number; anonymousAuthPerMinute: number }
}

export interface BillingCycle {
  start: Date
  end: Date
  daysLeft: number
}

const DAY_MS = 86_400_000

/** Siklus tagihan bulanan yang dimulai tiap tanggal billingDay (UTC); tanggal dibatasi 1-28 agar tiap bulan ada. */
export const billingCycle = (now: Date, billingDay: number): BillingCycle => {
  const day = Math.min(28, Math.max(1, Math.trunc(billingDay) || 1))
  let start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), day))
  if (start.getTime() > now.getTime()) start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, day))
  const end = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, day))
  return { start, end, daysLeft: Math.max(0, Math.ceil((end.getTime() - now.getTime()) / DAY_MS)) }
}

/** Jadwal cron: Senin dan Kamis 01:00 UTC (= 08:00 WIB); mengembalikan jadwal berikutnya setelah now. */
export const nextCronRun = (now: Date): Date => {
  for (let offset = 0; offset <= 7; offset++) {
    const candidate = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + offset, 1, 0, 0))
    const weekday = candidate.getUTCDay()
    if ((weekday === 1 || weekday === 4) && candidate.getTime() > now.getTime()) return candidate
  }
  return new Date(now.getTime() + 7 * DAY_MS)
}

const dateId = (date: Date, withTime = false) =>
  new Intl.DateTimeFormat('id-ID', {
    weekday: withTime ? 'long' : undefined,
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    ...(withTime ? { hour: '2-digit', minute: '2-digit' } : {}),
    timeZone: 'Asia/Jakarta',
  }).format(date)

const number = (value: number) => new Intl.NumberFormat('id-ID').format(Math.round(value))
const percent = (value: number, limit: number) => {
  const rounded = Math.round((value / limit) * 1000) / 10
  // pemakaian kecil tapi bukan nol jangan tampil 0%
  if (value > 0 && rounded === 0) return '<0,1%'
  return `${String(rounded).replace('.', ',')}%`
}
const size = (bytes: number) => (bytes >= 1024 ** 3 ? `${(bytes / 1024 ** 3).toFixed(2)} GB` : `${(bytes / 1024 ** 2).toFixed(1)} MB`)

const escapeHtml = (value: string) =>
  value.replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char] ?? char)

export interface UsageSectionInput {
  now: Date
  cycle: BillingCycle
  dbBytes: number
  overview: UsageOverview | null
  limits?: typeof SUPABASE_FREE_LIMITS
  app: AppLimits
}

type Row = [label: string, value: string, note?: string]

/** Perkiraan minimal pesan Realtime: tiap pesan baru dan tiap pesan dihapus/diedit disiarkan ke 2 anggota. */
export const estimateRealtimeMessages = (overview: UsageOverview): number => 2 * (overview.messages_created + overview.messages_deleted)

export const buildUsageSection = (input: UsageSectionInput): { text: string; html: string } => {
  const limits = input.limits ?? SUPABASE_FREE_LIMITS
  const { cycle, overview, app } = input

  const quota: Row[] = [
    ['Database', `${size(input.dbBytes)} / ${size(limits.databaseBytes)} (${percent(input.dbBytes, limits.databaseBytes)})`],
    overview
      ? ['Pengguna aktif bulanan (MAU)', `${number(overview.mau)} / ${number(limits.mau)} (${percent(overview.mau, limits.mau)})`, 'aktif di aplikasi sejak awal siklus']
      : ['Pengguna aktif bulanan (MAU)', 'belum tersedia', 'jalankan migrasi seru24_usage_overview'],
    overview
      ? [
        'Pesan Realtime (minimal)',
        `${number(estimateRealtimeMessages(overview))} / ${number(limits.realtimeMessages)} (${percent(estimateRealtimeMessages(overview), limits.realtimeMessages)})`,
        'hanya pesan baru dan hapus; belum termasuk status baca, mengetik, dan online, jadi angka di dashboard lebih besar',
      ]
      : ['Pesan Realtime', 'belum tersedia', 'jalankan migrasi seru24_usage_overview'],
  ]
  const unmeasured: Row[] = [
    ['Egress', `batas ${limits.egressGb} GB`, 'hanya terlihat di dashboard Supabase (Usage)'],
    ['Koneksi Realtime puncak', `batas ${limits.realtimePeakConnections}`, 'dashboard Supabase'],
    ['Log ingestion / Storage', `batas ${limits.logIngestionGb} GB / ${limits.storageGb} GB`, 'dashboard Supabase'],
  ]
  const limitRows: Row[] = [
    ['Panjang pesan teks', `${number(app.maxTextLength)} karakter`],
    ['Ukuran dokumen', `${size(app.maxFileBytes)} per file`],
    ['Batas permintaan (login)', `${number(app.rate.loggedInPerMinute)}/menit per pengguna+IP`],
    ['Batas permintaan (belum login)', `${app.rate.anonymousPerMinute}/menit per IP; login/daftar ${app.rate.anonymousAuthPerMinute}/menit`],
    ['Pemangkasan otomatis', `log dan pesan tertua dihapus bila database ≥ ${app.pruneAtMb} MB`],
  ]
  const schedule: Row[] = [
    ['Siklus tagihan Supabase', `${dateId(cycle.start)} – ${dateId(cycle.end)}`],
    ['Kuota direset', `${dateId(cycle.end)} (${cycle.daysLeft} hari lagi)`],
    ['Email laporan berikutnya', dateId(nextCronRun(input.now), true) + ' WIB'],
    ['Jadwal laporan', 'Senin dan Kamis 08.00 WIB'],
    ['Proyek Free dijeda', 'setelah 7 hari tanpa aktivitas; laporan ini memanggil database 2 kali seminggu sehingga tetap aktif'],
  ]

  const groups: Array<[string, Row[]]> = [
    ['Siklus dan jadwal', schedule],
    ['Pemakaian kuota Supabase (paket Free)', quota],
    ['Tidak terukur dari database', unmeasured],
    ['Batas aplikasi', limitRows],
  ]

  const text = groups
    .map(([title, rows]) => [`${title}:`, ...rows.map(([label, value, note]) => `- ${label}: ${value}${note ? ` (${note})` : ''}`)].join('\n'))
    .join('\n\n')

  const row = ([label, value, note]: Row) =>
    `<tr><td style="padding:8px 12px;border-bottom:1px solid #e2e8f0;color:#475569;">${escapeHtml(label)}${note ? `<br><span style="font-size:11px;color:#94a3b8;">${escapeHtml(note)}</span>` : ''}</td><td style="padding:8px 12px;border-bottom:1px solid #e2e8f0;text-align:right;font-weight:600;color:#0f172a;">${escapeHtml(value)}</td></tr>`
  const html = `<div style="padding:0 6px 18px;">${groups
    .map(
      ([title, rows]) =>
        `<h3 style="margin:20px 0 8px 0;font-size:16px;color:#0f172a;">${escapeHtml(title)}</h3><table style="width:100%;border-collapse:collapse;font-size:14px;">${rows.map(row).join('')}</table>`,
    )
    .join('')}</div>`

  return { text, html }
}

const FOOTER_MARKER = '<div style="background:#f8fafc;padding:10px'

/** Tempelkan bagian kuota ke email rekap: teks di akhir, HTML sebelum footer (atau di akhir bila footer tidak ditemukan). */
export const appendUsageSection = <T extends { text: string; html: string }>(mail: T, usage: { text: string; html: string }): T => ({
  ...mail,
  text: `${mail.text}\n\n${usage.text}`,
  html: mail.html.includes(FOOTER_MARKER) ? mail.html.replace(FOOTER_MARKER, () => `${usage.html}${FOOTER_MARKER}`) : `${mail.html}${usage.html}`,
})
