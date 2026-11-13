/**
 * Kirim push notification (FCM) ke perangkat penerima saat pesan baru berhasil disimpan.
 * Isi pesan tidak pernah dikirim ke server push (E2EE); HP hanya menerima "Pesan baru".
 */
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export default defineSecureHandler(async (event, payload) => {
  const user = await userFromToken(event, payload.access_token)
  const conversationId = typeof payload.conversation_id === 'string' ? payload.conversation_id.trim() : ''
  const messageId = typeof payload.message_id === 'string' ? payload.message_id.trim() : ''
  if (!UUID_PATTERN.test(conversationId) || !UUID_PATTERN.test(messageId)) {
    throw createError({ statusCode: 400, statusMessage: 'Data tidak valid' })
  }

  const fcm = parseFcmConfig(useRuntimeConfig(event))
  if (!fcm) {
    return { ok: true, sent: 0, configured: false }
  }

  const admin = requireServiceClient(event)
  const { data: targets, error } = await admin.rpc('seru24_push_targets_for_message', {
    p_sender: user.id,
    p_conversation_id: conversationId,
    p_message_id: messageId,
  })
  if (error) {
    throw new Error(`seru24_push_targets_for_message gagal: ${error.message}`)
  }

  const list = (targets as Array<{ token: string; platform: string }> | null) ?? []
  if (list.length === 0) {
    return { ok: true, sent: 0, configured: true }
  }

  const results = await Promise.all(
    list
      .filter((t) => t.platform === 'android' || t.platform === 'ios')
      .map((t) => sendFcmMessage(fcm, t.token, conversationId)),
  )

  const stale = results.filter((r) => r.unregistered).map((r) => r.token)
  if (stale.length > 0) {
    await admin.rpc('seru24_prune_push_tokens', { p_tokens: stale }).then(() => undefined, () => undefined)
  }

  return {
    ok: true,
    sent: results.filter((r) => r.ok).length,
    configured: true,
  }
}, { rejectedEvent: false, channel: 'server' })
