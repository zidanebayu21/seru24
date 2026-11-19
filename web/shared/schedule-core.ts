// Logika kirim terjadwal yang dipakai web dan Android: pilihan waktu, validasi, format, dan parameter RPC.
// Semua waktu dihitung di zona waktu perangkat; server menyimpan timestamptz (UTC).

export const MIN_SCHEDULE_LEAD_MS = 60_000
export const MAX_SCHEDULE_LEAD_MS = 30 * 86_400_000
export const MAX_PENDING_SCHEDULED = 20

export type ScheduleProblem = 'too_soon' | 'too_far'

export interface SchedulePreset {
  label: string
  at: Date
}

export interface ScheduledRow {
  id: string
  client_msg_id: string
  ciphertext: string
  nonce: string
  sender_key_version: number
  recipient_key_version: number
  send_at: string
  status: 'pending' | 'failed'
  error_code: string | null
}

export interface ScheduleResult {
  ok: boolean
  code?: string
  id?: string
  send_at?: string
}

/** Kode penolakan seru24_schedule_message dan alasan gagal terkirim -> pesan untuk pengguna. */
export const SCHEDULE_ERRORS: Record<string, string> = {
  device_not_registered: 'Perangkat belum terdaftar. Buka ulang aplikasi.',
  not_member: 'Percakapan tidak ditemukan.',
  unavailable: 'Pesan tidak dapat dikirim.',
  too_soon: 'Pilih waktu minimal 1 menit dari sekarang.',
  too_far: 'Maksimal 30 hari ke depan.',
  stale_key: 'Kunci lawan bicara berubah. Jadwalkan ulang pesan ini.',
  invalid_reply: 'Pesan yang dibalas tidak ditemukan.',
  too_many: `Maksimal ${MAX_PENDING_SCHEDULED} pesan terjadwal sekaligus.`,
  rate_limited: 'Terlalu cepat. Tunggu sebentar.',
  not_ready: 'Pesan terjadwal belum tersedia. Coba lagi nanti.',
  internal: 'Terjadi kesalahan di server.',
}

const withTime = (base: Date, dayOffset: number, hour: number, minute = 0) =>
  new Date(base.getFullYear(), base.getMonth(), base.getDate() + dayOffset, hour, minute, 0, 0)

/** Pilihan cepat: hanya yang masih di masa depan, tanpa duplikat. */
export const schedulePresets = (now: Date): SchedulePreset[] => {
  const presets: SchedulePreset[] = [{ label: 'Dalam 1 jam', at: new Date(now.getTime() + 3_600_000) }]
  const tonight = withTime(now, 0, 20)
  if (tonight.getTime() - now.getTime() > 3_600_000 + MIN_SCHEDULE_LEAD_MS) presets.push({ label: 'Nanti malam 20.00', at: tonight })
  presets.push({ label: 'Besok pagi 08.00', at: withTime(now, 1, 8) })
  const daysToMonday = ((8 - now.getDay()) % 7) || 7
  if (daysToMonday > 1) presets.push({ label: 'Senin 08.00', at: withTime(now, daysToMonday, 8) })
  return presets
}

export const validateScheduleTime = (at: Date, now: Date): ScheduleProblem | null => {
  const lead = at.getTime() - now.getTime()
  if (!Number.isFinite(lead) || lead < MIN_SCHEDULE_LEAD_MS) return 'too_soon'
  if (lead > MAX_SCHEDULE_LEAD_MS) return 'too_far'
  return null
}

/** Jam yang diketik (mis. "9", "9.30", "21:05") -> waktu terdekat berikutnya: hari ini bila belum lewat, selain itu besok. */
export const parseClockInput = (text: string, now: Date): Date | null => {
  const match = /^(\d{1,2})(?:[.:](\d{2}))?$/.exec(text.trim())
  if (!match) return null
  const hour = Number(match[1])
  const minute = match[2] === undefined ? 0 : Number(match[2])
  if (hour > 23 || minute > 59) return null
  const today = withTime(now, 0, hour, minute)
  return today.getTime() - now.getTime() >= MIN_SCHEDULE_LEAD_MS ? today : withTime(now, 1, hour, minute)
}

const pad = (value: number) => String(value).padStart(2, '0')

/** Nilai untuk <input type="datetime-local"> (waktu lokal, tanpa zona). */
export const toLocalInputValue = (date: Date) =>
  `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`

export const fromLocalInputValue = (value: string): Date | null => {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(value)
  if (!match) return null
  const [, year, month, day, hour, minute] = match.map(Number)
  const date = new Date(year!, month! - 1, day, hour, minute, 0, 0)
  return Number.isNaN(date.getTime()) ? null : date
}

/** "Hari ini 20.00", "Besok 08.00", atau "Sen, 23 Nov 08.00". */
export const formatScheduleTime = (iso: string, now: Date): string => {
  const date = new Date(iso)
  const clock = `${pad(date.getHours())}.${pad(date.getMinutes())}`
  const dayDiff = Math.round((withTime(date, 0, 0).getTime() - withTime(now, 0, 0).getTime()) / 86_400_000)
  if (dayDiff === 0) return `Hari ini ${clock}`
  if (dayDiff === 1) return `Besok ${clock}`
  const day = date.toLocaleDateString('id-ID', { weekday: 'short', day: 'numeric', month: 'short' })
  return `${day} ${clock}`
}

/** Parameter seru24_schedule_message dari hasil enkripsi pesan teks (p_kind tidak dikirim: selalu teks). */
export const toScheduleParams = (
  sealed: {
    p_conversation_id: string
    p_client_msg_id: string
    p_ciphertext: string
    p_nonce: string
    p_sender_key_version: number
    p_recipient_key_version: number
  },
  sendAt: Date,
  replyTo: string | null,
) => ({
  p_conversation_id: sealed.p_conversation_id,
  p_client_msg_id: sealed.p_client_msg_id,
  p_ciphertext: sealed.p_ciphertext,
  p_nonce: sealed.p_nonce,
  p_sender_key_version: sealed.p_sender_key_version,
  p_recipient_key_version: sealed.p_recipient_key_version,
  p_send_at: sendAt.toISOString(),
  p_reply_to: replyTo,
})

/** Bentuk pesan biasa dari baris terjadwal, agar bisa dibuka (didekripsi) dengan fungsi dekripsi yang sama. */
export const scheduledAsMessage = (row: ScheduledRow, conversationId: string, myId: string) => ({
  id: row.id,
  conversation_id: conversationId,
  sender_id: myId,
  seq: 0,
  client_msg_id: row.client_msg_id,
  kind: 'text' as const,
  ciphertext: row.ciphertext,
  nonce: row.nonce,
  sender_key_version: row.sender_key_version,
  recipient_key_version: row.recipient_key_version,
  reply_to: null,
  created_at: row.send_at,
  edited_at: null,
  deleted_at: null,
  expires_at: null,
})

export const scheduledFailureText = (row: Pick<ScheduledRow, 'error_code'>) =>
  SCHEDULE_ERRORS[row.error_code ?? ''] ?? 'Pesan terjadwal gagal dikirim.'
