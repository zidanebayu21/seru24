import type { H3Error, H3Event } from 'h3'

const MESSAGE_MAX = 500
const DETAIL_MAX = 300
const STACK_MAX = 1500

type LogChannel = 'auth' | 'server'

interface LogEntry {
  level: 'info' | 'warning' | 'error'
  channel: LogChannel
  event: string
  message: string
  status: number
  context: Record<string, unknown>
  userId?: string
}

/**
 * Tulis ke console (Vercel logs) dan seru24.system_logs lewat RPC khusus service_role.
 * Tanpa password, token, atau isi body permintaan (OWASP ASVS V7.1.1).
 */
const writeLog = async (event: H3Event, entry: LogEntry) => {
  const line = `[seru24] ${entry.level} ${entry.channel}.${entry.event} ${entry.message} ${JSON.stringify(entry.context)}`
  if (entry.level === 'error') console.error(line)
  else console.warn(line)

  const client = serviceClient(event)
  if (!client) return

  const { error } = await client
    .rpc('seru24_server_log', {
      p_level: entry.level,
      p_event: entry.event,
      p_message: entry.message.slice(0, MESSAGE_MAX),
      p_context: entry.context,
      p_status: entry.status,
      p_ip: getRequestIP(event, { xForwardedFor: true }) ?? null,
      p_user_agent: getRequestHeader(event, 'user-agent') ?? null,
      p_channel: entry.channel,
      p_user: entry.userId ?? null,
    })
    .then((res) => res, (e: unknown) => ({ error: e as Error }))
  if (error) console.error(`[seru24] gagal menulis system_logs: ${error.message}`)
}

const routeOf = (event: H3Event) => `${event.method} ${event.path.split('?')[0]}`

const causeMessage = (error: H3Error) =>
  error.cause instanceof Error ? error.cause.message.slice(0, DETAIL_MAX) : null

/** Kejadian autentikasi (OWASP ASVS V7.2.1). */
export const logAuthEvent = (
  event: H3Event,
  level: 'info' | 'warning',
  code: string,
  message: string,
  status: number,
  userId?: string,
) => writeLog(event, { level, channel: 'auth', event: code, message, status, context: {}, userId })

/** Keputusan autentikasi yang berhasil, mis. login_success. */
export const logAuthSuccess = (event: H3Event, code: string, userId: string, message: string) =>
  logAuthEvent(event, 'info', code, message, 200, userId)

export interface LoggedHandlerOptions {
  /** event_code untuk permintaan yang ditolak (4xx); false = tidak dicatat. */
  rejectedEvent?: string | false
  channel?: LogChannel
}

/**
 * defineEventHandler + pencatatan:
 *  - 4xx: dicatat sebagai warning (mis. login_failed) beserta alasan asli, lalu diteruskan apa adanya.
 *  - 5xx/error tak terduga: dicatat sebagai error, client hanya menerima log_id.
 */
export const defineLoggedHandler = <T>(
  handler: (event: H3Event) => Promise<T>,
  options: LoggedHandlerOptions = {},
) =>
  defineEventHandler(async (event) => {
    try {
      return await handler(event)
    } catch (error) {
      if (isError(error) && error.statusCode < 500) {
        if (options.rejectedEvent !== false) {
          await writeLog(event, {
            level: 'warning',
            channel: options.channel ?? 'server',
            event: options.rejectedEvent ?? 'request_rejected',
            message: `${routeOf(event)}: ${error.statusMessage ?? 'ditolak'}`,
            status: error.statusCode,
            context: { reason: causeMessage(error) },
          })
        }
        throw error
      }

      const logId = crypto.randomUUID()
      const err = error instanceof Error ? error : new Error(String(error))
      await writeLog(event, {
        level: 'error',
        channel: 'server',
        event: 'server_error',
        message: `${routeOf(event)}: ${err.message}`,
        status: 500,
        context: { log_id: logId, stack: err.stack?.slice(0, STACK_MAX) ?? null },
      })
      throw createError({ statusCode: 500, statusMessage: 'Terjadi kesalahan server', data: { log_id: logId } })
    }
  })
