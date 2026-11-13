import { createClient } from '@supabase/supabase-js'
import type { H3Event } from 'h3'

const MESSAGE_MAX = 500
const STACK_MAX = 1500

/**
 * Catat error tak terduga ke console (Vercel logs) dan seru24.system_logs.
 * Client hanya menerima log_id, tanpa detail internal (OWASP ASVS V7.4.1).
 */
export const logServerError = async (event: H3Event, error: unknown): Promise<string> => {
  const logId = crypto.randomUUID()
  const err = error instanceof Error ? error : new Error(String(error))
  const path = event.path.split('?')[0]
  const message = `${event.method} ${path}: ${err.message}`.slice(0, MESSAGE_MAX)
  console.error(`[seru24] log_id=${logId} ${message}`, err.stack)

  const config = useRuntimeConfig(event)
  if (!config.public.supabaseUrl || !config.supabaseServiceRoleKey) return logId

  const { error: writeError } = await createClient(config.public.supabaseUrl, config.supabaseServiceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  })
    .rpc('seru24_server_log', {
      p_level: 'error',
      p_event: 'server_error',
      p_message: message,
      p_context: { log_id: logId, stack: err.stack?.slice(0, STACK_MAX) ?? null },
      p_status: 500,
      p_ip: getRequestIP(event, { xForwardedFor: true }) ?? null,
      p_user_agent: getRequestHeader(event, 'user-agent') ?? null,
    })
    .then((res) => res, (e: unknown) => ({ error: e as Error }))
  if (writeError) console.error(`[seru24] log_id=${logId} gagal menulis system_logs: ${writeError.message}`)
  return logId
}

/** defineEventHandler + error 5xx dicatat dan diganti pesan generik berisi log_id. */
export const defineLoggedHandler = <T>(handler: (event: H3Event) => Promise<T>) =>
  defineEventHandler(async (event) => {
    try {
      return await handler(event)
    } catch (error) {
      if (isError(error) && error.statusCode < 500) throw error
      const logId = await logServerError(event, error)
      throw createError({ statusCode: 500, statusMessage: 'Terjadi kesalahan server', data: { log_id: logId } })
    }
  })
