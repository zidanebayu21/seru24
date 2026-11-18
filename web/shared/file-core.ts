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
