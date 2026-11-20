// Kualitas suara telepon per percakapan (bitrate Opus pengirim), bersama web dan mobile.
// Hanya mengatur suara yang KITA kirim; lawan bicara memilih untuk percakapan yang sama di perangkatnya.

export type CallQuality = 'hemat' | 'standar' | 'tinggi' | 'studio'

export interface CallQualityOption {
  value: CallQuality
  label: string
  /** Batas bitrate pengirim (bit per detik). */
  bitrate: number
}

export const CALL_QUALITIES: readonly CallQualityOption[] = [
  { value: 'hemat', label: 'Hemat data · 16 kbps', bitrate: 16_000 },
  { value: 'standar', label: 'Standar · 32 kbps', bitrate: 32_000 },
  { value: 'tinggi', label: 'Tinggi · 64 kbps', bitrate: 64_000 },
  { value: 'studio', label: 'Studio · 128 kbps', bitrate: 128_000 },
]

export const DEFAULT_CALL_QUALITY: CallQuality = 'standar'

export const isCallQuality = (value: unknown): value is CallQuality =>
  CALL_QUALITIES.some((option) => option.value === value)

export const callQualityOption = (value: CallQuality): CallQualityOption =>
  CALL_QUALITIES.find((option) => option.value === value) ?? CALL_QUALITIES[1]!

/** Kunci penyimpanan per percakapan. */
export const callQualityKey = (conversationId: string) => `seru24:call-quality:${conversationId}`

/** Pilihan tersimpan; nilai rusak atau storage yang error kembali ke bawaan. */
export const parseCallQuality = (raw: string | null | undefined): CallQuality => (isCallQuality(raw) ? raw : DEFAULT_CALL_QUALITY)

/** Pilihan berikutnya (berputar) untuk tombol yang berganti satu per satu. */
export const nextCallQuality = (current: CallQuality): CallQuality => {
  const index = CALL_QUALITIES.findIndex((option) => option.value === current)
  return CALL_QUALITIES[(index + 1) % CALL_QUALITIES.length]!.value
}
