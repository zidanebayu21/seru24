// Cuplikan pesan terakhir di daftar chat. Teks didekripsi di perangkat; tidak pernah dikirim atau disimpan ke server.

export interface Preview {
  text: string
  mine: boolean
  /** created_at pesan yang dicuplik; dibandingkan dengan last_message_at percakapan. */
  at: string
}

export const PREVIEW_MAX = 90
export const DELETED_PREVIEW = 'Pesan dihapus'

/** Satu baris pendek; pesan sendiri diberi awalan "Anda: ". */
export const previewText = (raw: string, mine: boolean): string => {
  const oneLine = raw.replace(/\s+/g, ' ').trim()
  if (!oneLine) return ''
  const cut = oneLine.length > PREVIEW_MAX ? `${oneLine.slice(0, PREVIEW_MAX - 1).trimEnd()}…` : oneLine
  return mine ? `Anda: ${cut}` : cut
}

/** Cuplikan masih mewakili pesan terakhir percakapan (tidak ada pesan yang lebih baru). */
export const isFreshPreview = (preview: Preview | undefined, lastMessageAt: string | null): boolean => {
  if (!preview || !lastMessageAt) return false
  return new Date(preview.at).getTime() >= new Date(lastMessageAt).getTime()
}

export const deletedPreview = (at: string): Preview => ({ text: DELETED_PREVIEW, mine: false, at })
