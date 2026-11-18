/**
 * Unduh satu potongan (maks 3 MiB) blob terenkripsi dari Drive; hanya untuk anggota percakapan.
 * Query part = nomor potongan mulai 0. Header x-file-size = ukuran total blob.
 */
import { FILE_CHUNK_BYTES } from '#shared/file-core'

export default defineLoggedHandler(async (event) => {
  const user = await bearerUser(event)
  const id = attachmentIdParam(event)
  const part = nonNegativeInt(getQuery(event).part)

  const file = await fileRpc<{ drive_file_id: string; size: number } | null>(event, 'seru24_file_for_download', {
    p_id: id,
    p_user: user.id,
  })
  if (!file?.drive_file_id) throw createError({ statusCode: 404, statusMessage: 'Dokumen tidak ditemukan' })

  const start = part * FILE_CHUNK_BYTES
  if (start >= file.size) throw createError({ statusCode: 416, statusMessage: 'Potongan di luar ukuran file' })
  const end = Math.min(start + FILE_CHUNK_BYTES, file.size) - 1

  const data = await downloadRange(driveConfig(event), file.drive_file_id, start, end)
  setResponseHeaders(event, {
    'content-type': 'application/octet-stream',
    'cache-control': 'no-store',
    'x-file-size': String(file.size),
  })
  return data
}, { rejectedEvent: 'file_rejected' })
