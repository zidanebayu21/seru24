/**
 * Hapus dokumen milik pengirim: tandai deleted di database lalu hapus permanen file di Drive.
 * Dipanggil sebelum seru24_delete_message saat pengirim menghapus pesan dokumen.
 */
import { isUuid } from '#shared/file-core'

export default defineSecureHandler(async (event, payload) => {
  const user = await userFromToken(event, payload.access_token)
  if (!isUuid(payload.id)) throw createError({ statusCode: 400, statusMessage: 'Data tidak valid' })

  const result = await fileRpc<{ ok: boolean; drive_file_id?: string | null }>(event, 'seru24_file_delete', {
    p_id: payload.id,
    p_user: user.id,
  })
  if (!result.ok) throw createError({ statusCode: 404, statusMessage: 'Dokumen tidak ditemukan' })
  if (result.drive_file_id) await deleteDriveFile(driveConfig(event), result.drive_file_id)
  return { ok: true }
}, { rejectedEvent: 'file_rejected' })
