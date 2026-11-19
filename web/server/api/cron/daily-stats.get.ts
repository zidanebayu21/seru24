/**
 * Endpoint cron non-Vercel untuk merekap daily_stats, mengeliminasi 1000 data tertua
 * bila DB Supabase >= 400 MB, membersihkan dokumen yatim di Google Drive, lalu mengirim email ringkasan (opsional).
 *
 * Dapat dipanggil oleh GitHub Actions, cron-job.org, atau manual dengan header
 * `Authorization: Bearer <CRON_SECRET>`. Tanpa CRON_SECRET endpoint selalu menolak (gagal tertutup);
 * secret tidak diterima lewat query string agar tidak tercatat di log akses (OWASP ASVS V4.1.5, CWE-598).
 */
import { MAX_TEXT_LENGTH } from '#shared/crypto'
import { MAX_FILE_BYTES } from '#shared/file-core'
import type { DailyStatsReport } from '../../utils/smtp'
import type { UsageOverview } from '../../utils/usage-report'

export default defineLoggedHandler(async (event) => {
  const config = useRuntimeConfig(event)
  const secret = String(config.cronSecret || process.env.CRON_SECRET || '')
  if (!isCronAuthorized(getHeader(event, 'authorization'), secret)) {
    throw createError({ statusCode: 401, statusMessage: 'Unauthorized' })
  }

  // NUXT_SMTP_ENABLED=false: deploy yang belum menyiapkan SMTP mematikan seluruh cron (rekap, retensi, perawatan dokumen, email)
  if (String(config.smtpEnabled).toLowerCase() === 'false') {
    return { ok: true, skipped: true, reason: 'Cron dimatikan (NUXT_SMTP_ENABLED=false)' }
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
  // perawatan dokumen tidak boleh menggagalkan rekap statistik; kegagalannya cukup tercatat di laporan
  report.files = await runFileMaintenance(event, dryRun).catch(() => null)
  const smtp = parseSmtpConfig(config as unknown as Record<string, unknown>)

  // kuota dan batas untuk email: dari database (migrasi seru24_usage_overview) bila sudah dijalankan; bila belum,
  // bagian itu menampilkan "belum tersedia" dan sisanya tetap terkirim
  const now = new Date()
  const cycle = billingCycle(now, Number(config.supabaseBillingDay) || 11)
  const overview = await Promise.resolve(admin.rpc('seru24_usage_overview', { p_from: cycle.start.toISOString() }))
    .then(({ data, error: rpcError }) => (rpcError ? null : (data as UsageOverview)), () => null)
  const usage = buildUsageSection({
    now,
    cycle,
    dbBytes: report.storage.db_size_bytes,
    overview,
    app: { maxTextLength: MAX_TEXT_LENGTH, maxFileBytes: MAX_FILE_BYTES, pruneAtMb: report.storage.limit_mb, rate: RATE_LIMITS },
  })

  let emailSent = false
  let emailNote = smtp ? 'dilewati (dryRun)' : 'SMTP belum dikonfigurasi'
  if (smtp && !dryRun) {
    const mail = appendUsageSection(buildDailyStatsEmail(report), usage)
    const result = await sendSmtpMail(smtp, mail)
    emailSent = true
    emailNote = result.response || 'terkirim'
  }

  return {
    ok: true,
    emailSent,
    emailNote,
    report,
    usage: { cycleStart: cycle.start.toISOString(), cycleEnd: cycle.end.toISOString(), daysLeft: cycle.daysLeft, overview },
  }
}, { rejectedEvent: 'cron_daily_stats_rejected', channel: 'server' })
