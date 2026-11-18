/**
 * Klien Google Drive minimal (REST v3) untuk dokumen chat: folder seru24/<conversation_id>,
 * upload resumable per potongan, unduh per rentang byte, dan hapus permanen.
 * Kredensial OAuth hanya di env server (NUXT_GDRIVE_*), tidak pernah dikirim ke browser (OWASP ASVS V2.10.4).
 */
import type { H3Event } from 'h3'

const TOKEN_URL = 'https://oauth2.googleapis.com/token'
const API = 'https://www.googleapis.com/drive/v3'
const UPLOAD_API = 'https://www.googleapis.com/upload/drive/v3'
const FOLDER_MIME = 'application/vnd.google-apps.folder'
const ROOT_FOLDER_NAME = 'seru24'

export interface DriveConfig {
  clientId: string
  clientSecret: string
  refreshToken: string
}

export type ChunkResult = { done: false; received: number } | { done: true; fileId: string }

let cachedToken: { value: string; expiresAt: number } | null = null
const folderCache = new Map<string, string>()

export const driveConfig = (event: H3Event): DriveConfig => {
  const config = useRuntimeConfig(event)
  const drive = {
    clientId: String(config.gdriveClientId ?? ''),
    clientSecret: String(config.gdriveClientSecret ?? ''),
    refreshToken: String(config.gdriveRefreshToken ?? ''),
  }
  if (!drive.clientId || !drive.clientSecret || !drive.refreshToken) {
    throw new Error('Konfigurasi belum lengkap: NUXT_GDRIVE_CLIENT_ID/SECRET/REFRESH_TOKEN kosong')
  }
  return drive
}

/** Header Range dari Drive ("bytes=0-3145727") -> jumlah byte yang sudah diterima. */
export const receivedFromRange = (range: string | null): number => {
  const match = /bytes=0-(\d+)/.exec(range ?? '')
  return match ? Number(match[1]) + 1 : 0
}

const failure = async (res: Response, action: string) =>
  new Error(`Drive ${action} gagal (${res.status}): ${(await res.text().catch(() => '')).slice(0, 300)}`)

const accessToken = async (config: DriveConfig): Promise<string> => {
  if (cachedToken && Date.now() < cachedToken.expiresAt) return cachedToken.value
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: config.clientId,
      client_secret: config.clientSecret,
      refresh_token: config.refreshToken,
      grant_type: 'refresh_token',
    }),
  })
  if (!res.ok) throw await failure(res, 'token')
  const data = (await res.json()) as { access_token: string; expires_in: number }
  cachedToken = { value: data.access_token, expiresAt: Date.now() + (data.expires_in - 60) * 1000 }
  return data.access_token
}

const driveFetch = async (config: DriveConfig, url: string, init: RequestInit = {}) =>
  fetch(url, { ...init, headers: { ...init.headers, authorization: `Bearer ${await accessToken(config)}` } })

const findOrCreateFolder = async (config: DriveConfig, name: string, parent: string): Promise<string> => {
  const cacheKey = `${parent}/${name}`
  const cached = folderCache.get(cacheKey)
  if (cached) return cached

  const q = `name = '${name}' and mimeType = '${FOLDER_MIME}' and '${parent}' in parents and trashed = false`
  const list = await driveFetch(config, `${API}/files?${new URLSearchParams({ q, fields: 'files(id)', pageSize: '1' })}`)
  if (!list.ok) throw await failure(list, 'cari folder')
  let id = ((await list.json()) as { files: Array<{ id: string }> }).files[0]?.id

  if (!id) {
    const created = await driveFetch(config, `${API}/files?fields=id`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name, mimeType: FOLDER_MIME, parents: [parent] }),
    })
    if (!created.ok) throw await failure(created, 'buat folder')
    id = ((await created.json()) as { id: string }).id
  }
  folderCache.set(cacheKey, id)
  return id
}

/** Buka sesi upload resumable di seru24/<conversationId>/<attachmentId>.bin; URL sesi hanya disimpan di server. */
export const startUpload = async (
  config: DriveConfig,
  conversationId: string,
  attachmentId: string,
  size: number,
): Promise<string> => {
  const root = await findOrCreateFolder(config, ROOT_FOLDER_NAME, 'root')
  const folder = await findOrCreateFolder(config, conversationId, root)
  const res = await driveFetch(config, `${UPLOAD_API}/files?uploadType=resumable&fields=id`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json; charset=UTF-8',
      'x-upload-content-type': 'application/octet-stream',
      'x-upload-content-length': String(size),
    },
    body: JSON.stringify({ name: `${attachmentId}.bin`, parents: [folder], mimeType: 'application/octet-stream' }),
  })
  const session = res.headers.get('location')
  if (!res.ok || !session) throw await failure(res, 'mulai upload')
  return session
}

/** Kirim satu potongan [start, start + data.length) ke sesi upload. */
export const uploadChunk = async (
  session: string,
  data: Uint8Array,
  start: number,
  total: number,
): Promise<ChunkResult> => {
  const end = start + data.length - 1
  const res = await fetch(session, {
    method: 'PUT',
    headers: { 'content-range': `bytes ${start}-${end}/${total}` },
    body: data as Uint8Array<ArrayBuffer>,
  })
  if (res.status === 308) return { done: false, received: receivedFromRange(res.headers.get('range')) }
  if (!res.ok) throw await failure(res, 'upload potongan')
  return { done: true, fileId: ((await res.json()) as { id: string }).id }
}

/** Ambil rentang byte [start, end] file; dipakai unduh per potongan (respons Vercel maks 4,5 MB). */
export const downloadRange = async (
  config: DriveConfig,
  fileId: string,
  start: number,
  end: number,
): Promise<Uint8Array> => {
  const res = await driveFetch(config, `${API}/files/${encodeURIComponent(fileId)}?alt=media`, {
    headers: { range: `bytes=${start}-${end}` },
  })
  if (!res.ok) throw await failure(res, 'unduh')
  return new Uint8Array(await res.arrayBuffer())
}

/** Hapus permanen (tidak lewat Trash). File yang sudah tidak ada dianggap berhasil. */
export const deleteDriveFile = async (config: DriveConfig, fileId: string): Promise<void> => {
  const res = await driveFetch(config, `${API}/files/${encodeURIComponent(fileId)}`, { method: 'DELETE' })
  if (!res.ok && res.status !== 404) throw await failure(res, 'hapus')
}
