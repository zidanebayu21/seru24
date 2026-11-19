// Pencarian pesan di perangkat. Hanya membaca teks yang sudah didekripsi di memori klien; tidak ada panggilan ke
// server, jadi kata yang dicari tidak pernah meninggalkan perangkat (pesan E2EE tetap tidak terbaca server).
// Rujukan: OWASP ASVS V8.3 (perlindungan data sensitif), V6.4 (hanya klien yang memegang kunci).

export interface SearchableMessage {
  key: string
  seq: number
  createdAt: string
  text: string | null
  deleted: boolean
}

export interface SearchHit {
  key: string
  seq: number
  createdAt: string
  /** Cuplikan: bagian sebelum, kata yang cocok (untuk disorot), dan sesudahnya. */
  before: string
  match: string
  after: string
}

const CONTEXT_CHARS = 32

/** Abaikan huruf besar/kecil dan tanda diakritik (é = e). */
export const normalizeForSearch = (value: string): string => value.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase()

/** Teks yang sudah dinormalisasi beserta indeks asli tiap karakter, agar posisi sorotan tepat di teks asli. */
const foldWithMap = (text: string): { folded: string; origin: number[] } => {
  let folded = ''
  const origin: number[] = []
  let index = 0
  for (const char of text) {
    const normalized = normalizeForSearch(char)
    for (let i = 0; i < normalized.length; i++) origin.push(index)
    folded += normalized
    index += char.length
  }
  return { folded, origin }
}

const snippetOf = (text: string, start: number, end: number) => {
  const from = Math.max(0, start - CONTEXT_CHARS)
  const to = Math.min(text.length, end + CONTEXT_CHARS)
  return {
    before: `${from > 0 ? '…' : ''}${text.slice(from, start).replace(/\s+/g, ' ')}`,
    match: text.slice(start, end),
    after: `${text.slice(end, to).replace(/\s+/g, ' ')}${to < text.length ? '…' : ''}`,
  }
}

/** Pesan yang memuat semua kata kueri (urutan bebas), terbaru dulu; kata pertama yang ditemukan disorot. */
export const searchMessages = (messages: SearchableMessage[], query: string, limit = 100): SearchHit[] => {
  const terms = normalizeForSearch(query).split(/\s+/).filter(Boolean)
  if (terms.length === 0) return []

  const hits: SearchHit[] = []
  for (const message of [...messages].sort((a, b) => b.seq - a.seq)) {
    if (message.deleted || !message.text) continue
    const { folded, origin } = foldWithMap(message.text)
    if (!terms.every((term) => folded.includes(term))) continue

    const first = terms.map((term) => ({ term, at: folded.indexOf(term) })).sort((a, b) => a.at - b.at)[0]!
    const start = origin[first.at] ?? 0
    // akhir sorotan = awal karakter asli berikutnya (satu karakter asli bisa menjadi beberapa karakter ternormalisasi)
    let endFolded = first.at + first.term.length
    while (endFolded < origin.length && origin[endFolded] === origin[endFolded - 1]) endFolded++
    const end = endFolded < origin.length ? (origin[endFolded] ?? message.text.length) : message.text.length

    hits.push({ key: message.key, seq: message.seq, createdAt: message.createdAt, ...snippetOf(message.text, start, end) })
    if (hits.length >= limit) break
  }
  return hits
}
