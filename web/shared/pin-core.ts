// Pesan yang disematkan (pin) di atas percakapan. Hanya menyimpan penanda pesan (client_msg_id) di perangkat; isi pesan
// tetap terenkripsi end-to-end dan tidak pernah dikirim ke server. Daftar disimpan dari yang tertua ke terbaru.
// Rujukan: OWASP ASVS V8.3 (perlindungan data sensitif), V5.1 (validasi data dari penyimpanan lokal).

export const MAX_PINS = 10

/** Kunci penyimpanan per akun dan percakapan, supaya pin akun lain di perangkat yang sama tidak tercampur. */
export const pinsStorageKey = (userId: string, conversationId: string): string => `pins.${userId}.${conversationId}`

/** Baca daftar dari penyimpanan; data rusak atau tidak sah dibuang agar tidak merusak tampilan. */
export const parsePins = (raw: string | null | undefined): string[] => {
  if (!raw) return []
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    const unique = new Set(parsed.filter((item): item is string => typeof item === 'string' && item.length > 0))
    return [...unique].slice(-MAX_PINS)
  } catch {
    return []
  }
}

/** Tombol pin dinonaktifkan saat sudah penuh, kecuali untuk pesan yang sudah di-pin (agar bisa dilepas). */
export const canPin = (pins: readonly string[]): boolean => pins.length < MAX_PINS

/** Tambah pin paling baru; tidak berubah bila sudah ada atau sudah penuh. */
export const addPin = (pins: readonly string[], key: string): string[] =>
  pins.includes(key) || !canPin(pins) ? [...pins] : [...pins, key]

export const removePin = (pins: readonly string[], key: string): string[] => pins.filter((item) => item !== key)

/** Buang pin yang pesannya sudah tidak ada (dihapus pengguna atau terpangkas dari server dan cache). */
export const prunePins = (pins: readonly string[], liveKeys: ReadonlySet<string>): string[] =>
  pins.filter((key) => liveKeys.has(key))

/** Urutan tampil: pin terakhir di paling atas. */
export const pinsNewestFirst = (pins: readonly string[]): string[] => [...pins].reverse()
