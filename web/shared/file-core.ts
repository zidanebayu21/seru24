// Aturan dokumen chat bersama web, mobile, dan server: batas ukuran, potongan upload, dan isi pesan file.

/** Ukuran file asli maksimal (50 MiB). */
export const MAX_FILE_BYTES = 50 * 1024 * 1024
/** Tag autentikasi AES-GCM yang menempel di belakang blob terenkripsi. */
export const FILE_TAG_BYTES = 16
/** Ukuran blob terenkripsi maksimal yang diterima server. */
export const MAX_ENCRYPTED_BYTES = MAX_FILE_BYTES + FILE_TAG_BYTES
/** 3 MiB per permintaan: di bawah batas body Vercel 4,5 MB dan kelipatan 256 KiB sesuai syarat upload resumable Drive. */
export const FILE_CHUNK_BYTES = 3 * 1024 * 1024
export const MAX_FILE_NAME_LENGTH = 200

/** Isi pesan kind 'file' (di dalam ciphertext E2EE, tidak pernah terlihat server). */
export interface FileMessageBody {
  id: string
  name: string
  mime: string
  size: number
  /** Kunci AES-256-GCM file (base64). */
  key: string
  /** Nonce AES-GCM file (base64). */
  iv: string
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const KEY_PATTERN = /^[A-Za-z0-9+/]{43}=$/
const IV_PATTERN = /^[A-Za-z0-9+/]{16}$/

export const isUuid = (value: unknown): value is string => typeof value === 'string' && UUID_PATTERN.test(value)

/** Nama file aman ditampilkan: tanpa path dan karakter kontrol, panjang dibatasi. */
export const safeFileName = (name: string): string => {
  const base = name.split(/[\\/]/).pop() ?? ''
  const clean = [...base].filter((ch) => ch >= ' ' && ch !== '\u007f').join('').trim()
  return (clean || 'dokumen').slice(0, MAX_FILE_NAME_LENGTH)
}

const VOICE_MIME = /^audio\/(webm|ogg|mp4|mpeg|wav|aac|x-m4a)$/

/** Tipe dasar tanpa parameter (mis. "audio/webm;codecs=opus" -> "audio/webm"), huruf kecil. */
export const baseMime = (mime: string): string => (mime.split(';')[0] ?? '').trim().toLowerCase()

/** Hanya audio dari daftar ini yang diputar di chat; mime berasal dari pengirim sehingga tidak dipercaya mentah. */
export const isVoiceFile = (file: { mime: string }): boolean => VOICE_MIME.test(baseMime(file.mime))

const VOICE_SECONDS_IN_NAME = /-(\d{1,5})s\.[a-z0-9]{2,4}$/i

/** Nama file pesan suara memuat durasi (suara-20261119-1030-23s.webm); rekaman MediaRecorder tidak punya metadata durasi. */
export const voiceFileName = (seconds: number, extension: string, now: Date = new Date()): string => {
  const pad = (value: number) => String(value).padStart(2, '0')
  const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}`
  return `suara-${stamp}-${Math.max(0, Math.round(seconds))}s.${extension}`
}

export const voiceSecondsFromName = (name: string): number | null => {
  const match = VOICE_SECONDS_IN_NAME.exec(name)
  return match ? Number(match[1]) : null
}

/** Mis. 0:07 atau 1:05. */
export const formatClockSeconds = (seconds: number): string => {
  const total = Math.max(0, Math.floor(seconds))
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`
}

/** Validasi isi pesan file hasil dekripsi; null bila bentuknya tidak sesuai. */
export const parseFileBody = (value: unknown): FileMessageBody | null => {
  if (!value || typeof value !== 'object') return null
  const f = value as Record<string, unknown>
  if (!isUuid(f.id) || typeof f.name !== 'string' || typeof f.mime !== 'string') return null
  if (typeof f.size !== 'number' || !Number.isInteger(f.size) || f.size < 0 || f.size > MAX_FILE_BYTES) return null
  if (typeof f.key !== 'string' || !KEY_PATTERN.test(f.key)) return null
  if (typeof f.iv !== 'string' || !IV_PATTERN.test(f.iv)) return null
  return { id: f.id, name: safeFileName(f.name), mime: f.mime.slice(0, 100), size: f.size, key: f.key, iv: f.iv }
}

/** Rentang byte [start, end) tiap potongan untuk blob berukuran total. */
export const chunkRanges = (total: number, chunk = FILE_CHUNK_BYTES): Array<[number, number]> => {
  const ranges: Array<[number, number]> = []
  for (let start = 0; start < total; start += chunk) ranges.push([start, Math.min(start + chunk, total)])
  return ranges
}

export const formatFileSize = (bytes: number): string => {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

export const formatDuration = (seconds: number): string => {
  const total = Math.max(1, Math.round(seconds))
  if (total < 60) return `${total} dtk`
  if (total < 3600) return `${Math.floor(total / 60)} mnt ${total % 60} dtk`
  return `${Math.floor(total / 3600)} j ${Math.floor((total % 3600) / 60)} mnt`
}

export interface TransferStatus {
  /** 0..1 untuk bar progres. */
  fraction: number
  /** Mis. "Mengunggah 34% · 1.2 MB/dtk · sisa 12 dtk". */
  label: string
}

/**
 * Kecepatan dan sisa waktu dihitung dari byte yang bergerak sejak laporan pertama (bukan sejak mulai enkripsi),
 * jadi tidak terdistorsi waktu persiapan. Kecepatan baru tampil setelah ada dua laporan.
 */
export const createTransferMeter = (verb: string, now: () => number = Date.now) => {
  let first: { at: number; done: number } | null = null
  return (done: number, total: number): TransferStatus => {
    const fraction = Math.min(1, Math.max(0, done / Math.max(total, 1)))
    const at = now()
    first ??= { at, done }
    const parts = [`${verb} ${Math.round(fraction * 100)}%`]
    const elapsedSeconds = (at - first.at) / 1000
    const speed = elapsedSeconds > 0 ? (done - first.done) / elapsedSeconds : 0
    if (speed > 0) {
      parts.push(`${formatFileSize(speed)}/dtk`)
      if (total > done) parts.push(`sisa ${formatDuration((total - done) / speed)}`)
    }
    return { fraction, label: parts.join(' · ') }
  }
}

/** Pisahkan file yang boleh dikirim dari yang melebihi batas; message = isi popup (null bila semua boleh). */
export const splitByFileLimit = <T extends { name: string; size: number }>(files: T[]): { allowed: T[]; message: string | null } => {
  const allowed = files.filter((file) => file.size <= MAX_FILE_BYTES)
  const rejected = files.filter((file) => file.size > MAX_FILE_BYTES)
  if (rejected.length === 0) return { allowed, message: null }
  const names = rejected.map((file) => `${safeFileName(file.name)} (${formatFileSize(file.size)})`).join(', ')
  return { allowed, message: `Melebihi batas ${formatFileSize(MAX_FILE_BYTES)} per file, tidak dikirim: ${names}` }
}
