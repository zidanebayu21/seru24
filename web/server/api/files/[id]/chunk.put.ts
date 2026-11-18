/**
 * Terima satu potongan (maks 3 MiB) blob terenkripsi lalu teruskan ke sesi upload Drive.
 * Header x-upload-offset = posisi byte awal potongan. Potongan terakhir menandai lampiran siap dikirim.
 */
export default defineLoggedHandler(async (event) => {
  assertSameOrigin(event)
  const user = await bearerUser(event)
  const id = attachmentIdParam(event)
  const offset = nonNegativeInt(getRequestHeader(event, 'x-upload-offset'))
  const chunk = await readChunk(event)

  const upload = await fileRpc<{ session: string; size: number } | null>(event, 'seru24_file_for_upload', {
    p_id: id,
    p_user: user.id,
  })
  if (!upload?.session) throw createError({ statusCode: 404, statusMessage: 'Upload tidak ditemukan' })
  if (offset + chunk.length > upload.size) throw createError({ statusCode: 400, statusMessage: 'Potongan melebihi ukuran file' })

  const result = await uploadChunk(upload.session, chunk, offset, upload.size)
  if (!result.done) return { done: false, received: result.received }

  await fileRpc<boolean>(event, 'seru24_file_finish', { p_id: id, p_user: user.id, p_drive_file_id: result.fileId })
  return { done: true, received: upload.size }
}, { rejectedEvent: 'file_rejected' })
