/**
 * Endpoint cron non-Vercel untuk merekap daily_stats, mengeliminasi 1000 data tertua
 * bila DB Supabase >= 400 MB, lalu mengirim email ringkasan harian (opsional).
 *
 * Dapat dipanggil oleh GitHub Actions, cron-job.org, atau manual dengan header
 * `Authorization: Bearer <CRON_SECRET>`. Tanpa CRON_SECRET endpoint selalu menolak (gagal tertutup);
 * secret tidak diterima lewat query string agar tidak tercatat di log akses (OWASP ASVS V4.1.5, CWE-598).
 */
import type { DailyStatsReport } from '../../utils/smtp'

export default defineLoggedHandler(async (event) => {
  const config = useRuntimeConfig(event)
  const secret = String(config.cronSecret || process.env.CRON_SECRET || '')
  if (!isCronAuthorized(getHeader(event, 'authorization'), secret)) {
    throw createError({ statusCode: 401, statusMessage: 'Unauthorized' })
  }

  const query = getQuery(event)
  const dayParam = typeof query.day === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(query.day) ? query.day : null
  const dryRun = query.dryRun === '1' || query.dryRun === 'true'

  const admin = requireServiceClient(event)
  const { data, error } = await admin.rpc('seru24_collect_daily_stats_and_prune', dayParam ? { p_day: dayParam } : {})
  if (error) {
    throw new Error(`seru24_collect_daily_stats_and_prune gagal: ${error.message}`)
  }

  const report = data as DailyStatsReport
  const smtp = parseSmtpConfig(config as unknown as Record<string, unknown>)

  let emailSent = false
  let emailNote = smtp ? 'dilewati (dryRun)' : 'SMTP belum dikonfigurasi'
  if (smtp && !dryRun) {
    const mail = buildDailyStatsEmail(report)
    const result = await sendSmtpMail(smtp, mail)
    emailSent = true
    emailNote = result.response || 'terkirim'
  }

  return {
    ok: true,
    emailSent,
    emailNote,
    report,
  }
}, { rejectedEvent: 'cron_daily_stats_rejected', channel: 'server' })
