// Rekaman panggilan suara lokal (web): nama berkas dan format. Rekaman hanya disimpan di perangkat perekam
// (diunduh sebagai berkas), tidak dikirim ke server; lawan bicara diberi tahu lewat sinyal "record" (call-core).

const MIME_CANDIDATES = ['audio/webm;codecs=opus', 'audio/ogg;codecs=opus', 'audio/webm', 'audio/mp4']

/** Format rekaman pertama yang didukung browser; undefined = biarkan browser memilih. */
export const pickRecorderMime = (isTypeSupported: (mime: string) => boolean): string | undefined =>
  MIME_CANDIDATES.find((mime) => isTypeSupported(mime))

const pad = (n: number) => String(n).padStart(2, '0')

const extensionFor = (mime: string) => (mime.includes('ogg') ? 'ogg' : mime.includes('mp4') ? 'm4a' : 'webm')

/** Nama berkas aman: panggilan-<lawan>-<tanggal>-<jam>.<ekstensi>. */
export const recordingFileName = (peerName: string, mime: string, date = new Date()): string => {
  const peer = peerName.toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 30) || 'lawan'
  const day = `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}`
  const time = `${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
  return `panggilan-${peer}-${day}-${time}.${extensionFor(mime)}`
}

const AUTO_RECORD_KEY = 'seru24:call-auto-record'

/** Pengaturan "rekam otomatis saat telepon" (per perangkat, bawaan mati); storage bisa tidak tersedia. */
export const loadAutoRecord = (storage: Pick<Storage, 'getItem'> | undefined): boolean => {
  try {
    return storage?.getItem(AUTO_RECORD_KEY) === '1'
  } catch {
    return false
  }
}

export const saveAutoRecord = (storage: Pick<Storage, 'setItem'> | undefined, on: boolean) => {
  try {
    storage?.setItem(AUTO_RECORD_KEY, on ? '1' : '0')
  } catch {
    // mode privat: pengaturan hanya berlaku selama tab terbuka
  }
}
