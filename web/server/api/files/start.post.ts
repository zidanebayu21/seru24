/**
 * Mulai upload dokumen: cek anggota percakapan dan batas ukuran, buat baris attachments,
 * lalu buka sesi upload resumable Drive di folder seru24/<conversation_id>.
 */
import { FILE_CHUNK_BYTES, MAX_ENCRYPTED_BYTES, isUuid } from '#shared/file-core'

const REJECT_STATUS: Record<string, number> = { rate_limited: 429, too_large: 413 }

export default defineSecureHandler(async (event, payload) => {
  const user = await userFromToken(event, payload.access_token)
  const conversationId = payload.conversation_id
  const size = payload.size
  if (!isUuid(conversationId) || typeof size !== 'number' || !Number.isInteger(size) || size < 1 || size > MAX_ENCRYPTED_BYTES) {
    throw createError({ statusCode: 400, statusMessage: 'Data tidak valid' })
  }

  const drive = driveConfig(event)
  const begin = await fileRpc<{ ok: boolean; code?: string; id?: string }>(event, 'seru24_file_begin', {
    p_user: user.id,
    p_conversation_id: conversationId,
    p_size: size,
  })
  if (!begin.ok || !begin.id) {
    throw createError({ statusCode: REJECT_STATUS[begin.code ?? ''] ?? 403, statusMessage: 'Dokumen ditolak', data: { code: begin.code } })
  }

  const session = await startUpload(drive, conversationId, begin.id, size)
  if (!(await fileRpc<boolean>(event, 'seru24_file_set_session', { p_id: begin.id, p_user: user.id, p_session: session }))) {
    throw new Error('Sesi upload gagal disimpan')
  }
  return { id: begin.id, chunk_size: FILE_CHUNK_BYTES }
}, { rejectedEvent: 'file_rejected' })
