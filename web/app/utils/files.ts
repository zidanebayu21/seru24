import { fromBase64, toBase64 } from '#shared/crypto'
import {
  FILE_CHUNK_BYTES,
  FILE_TAG_BYTES,
  MAX_FILE_BYTES,
  chunkRanges,
  formatFileSize,
  safeFileName,
  type FileMessageBody,
} from '#shared/file-core'

// Dokumen chat: dienkripsi AES-256-GCM di browser dengan kunci acak per file (kunci ikut di pesan E2EE),
// lalu blob terenkripsi dikirim per potongan 3 MiB ke /api/files/* yang meneruskannya ke Google Drive.

export type Progress = (done: number, total: number) => void

const CHUNK_RETRIES = 3

const requireToken = async () => {
  const token = await getAccessToken()
  if (!token) throw new Error('Sesi berakhir, silakan masuk lagi')
  return token
}

const authHeader = async () => ({ authorization: `Bearer ${await requireToken()}` })

const withRetry = async <T>(run: () => Promise<T>): Promise<T> => {
  let lastError: unknown
  for (let attempt = 0; attempt < CHUNK_RETRIES; attempt++) {
    try {
      return await run()
    } catch (e) {
      lastError = e
      await new Promise((resolve) => setTimeout(resolve, 500 * (attempt + 1)))
    }
  }
  throw lastError
}

const encryptFileData = async (file: File) => {
  const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt'])
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const data = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, await file.arrayBuffer()))
  const rawKey = new Uint8Array(await crypto.subtle.exportKey('raw', key))
  const encoded = { key: toBase64(rawKey), iv: toBase64(iv) }
  rawKey.fill(0)
  return { data, ...encoded }
}

/** Enkripsi lalu unggah satu file; hasilnya isi pesan kind 'file' yang siap dienkripsi E2EE. */
export const uploadFile = async (conversationId: string, file: File, onProgress?: Progress): Promise<FileMessageBody> => {
  if (file.size > MAX_FILE_BYTES) throw new Error(`Maksimal ${formatFileSize(MAX_FILE_BYTES)} per file`)
  const sealed = await encryptFileData(file)
  const total = sealed.data.length

  const start = await secureFetch<{ id: string }>('/api/files/start', {
    access_token: await requireToken(),
    conversation_id: conversationId,
    size: total,
  })

  let offset = 0
  while (offset < total) {
    const from = offset
    const result = await withRetry(async () => {
      const res = await fetch(`/api/files/${start.id}/chunk`, {
        method: 'PUT',
        headers: { ...(await authHeader()), 'content-type': 'application/octet-stream', 'x-upload-offset': String(from) },
        body: sealed.data.subarray(from, Math.min(from + FILE_CHUNK_BYTES, total)),
      })
      if (!res.ok) throw new Error(`Upload gagal (${res.status})`)
      return (await res.json()) as { done: boolean; received: number }
    })
    offset = result.done ? total : result.received
    onProgress?.(offset, total)
  }
  sealed.data.fill(0)

  return {
    id: start.id,
    name: safeFileName(file.name),
    mime: file.type || 'application/octet-stream',
    size: file.size,
    key: sealed.key,
    iv: sealed.iv,
  }
}

/** Unduh per potongan, dekripsi di browser, lalu simpan dengan nama aslinya. */
export const downloadFile = async (file: FileMessageBody, onProgress?: Progress): Promise<void> => {
  const total = file.size + FILE_TAG_BYTES
  const encrypted = new Uint8Array(total)
  for (const [index, [from]] of chunkRanges(total).entries()) {
    const part = await withRetry(async () => {
      const res = await fetch(`/api/files/${file.id}/chunk?part=${index}`, { headers: await authHeader(), cache: 'no-store' })
      if (!res.ok) throw new Error(`Unduh gagal (${res.status})`)
      return new Uint8Array(await res.arrayBuffer())
    })
    encrypted.set(part, from)
    onProgress?.(from + part.length, total)
  }

  const rawKey = new Uint8Array(fromBase64(file.key))
  const key = await crypto.subtle.importKey('raw', rawKey, 'AES-GCM', false, ['decrypt'])
  rawKey.fill(0)
  const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: new Uint8Array(fromBase64(file.iv)) }, key, encrypted)
  const url = URL.createObjectURL(new Blob([plain], { type: 'application/octet-stream' }))
  const link = document.createElement('a')
  link.href = url
  link.download = file.name
  link.click()
  setTimeout(() => URL.revokeObjectURL(url), 10_000)
}

/** Hapus dokumen di server dan Google Drive (hanya pengunggah). */
export const deleteRemoteFile = async (id: string): Promise<void> => {
  await secureFetch('/api/files/delete', { access_token: await requireToken(), id })
}
