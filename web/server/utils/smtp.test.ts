import { describe, expect, it } from 'vitest'
import { buildDailyStatsEmail, parseSmtpConfig, type DailyStatsReport } from './smtp'

describe('smtp daily stats helper', () => {
  it('membaca konfigurasi SMTP dan menentukan mode secure dari port 465 vs 587', () => {
    expect(parseSmtpConfig({}, {})).toBeNull()

    const tls587 = parseSmtpConfig(
      { smtpHost: 'smtp.gmail.com', smtpUser: 'bot@example.com', smtpPass: 'secret' },
      {},
    )
    expect(tls587).toEqual({
      host: 'smtp.gmail.com',
      port: 587,
      secure: false,
      user: 'bot@example.com',
      pass: 'secret',
      from: 'bot@example.com',
      to: ['bot@example.com'],
    })

    const ssl465 = parseSmtpConfig(
      {},
      {
        SMTP_HOST: 'smtp.gmail.com',
        SMTP_PORT: '465',
        SMTP_USER: 'bot@example.com',
        SMTP_PASS: 'secret',
        SMTP_TARGET_EMAIL: 'a@example.com, b@example.com',
      },
    )
    expect(ssl465?.secure).toBe(true)
    expect(ssl465?.to).toEqual(['a@example.com', 'b@example.com'])
  })

  it('menyusun email laporan harian dan info eliminasi 1000 data tertua', () => {
    const report: DailyStatsReport = {
      day: '2026-11-18',
      daily: {
        registrations: 4,
        logins_success: 18,
        logins_failed: 2,
        active_users: 12,
        messages_sent: 245,
        messages_rejected: 1,
        attachments_sent: 3,
        reports_opened: 0,
      },
      totals: {
        users: 55,
        conversations: 29,
        messages: 12_400,
        system_logs: 4_800,
        open_reports: 1,
      },
      storage: {
        db_size_bytes: 429_916_160,
        db_size_after_bytes: 429_916_160,
        db_size_mb: 410,
        limit_bytes: 419_430_400,
        limit_mb: 400,
        over_limit: true,
        pruned: true,
        pruned_logs: 620,
        pruned_messages: 380,
        deleted_expired_messages: 5,
        deleted_rate_limits: 14,
      },
    }

    const email = buildDailyStatsEmail(report, new Date('2026-11-18T01:00:00Z'))
    expect(email.subject).toContain('2026-11-18')
    expect(email.subject).toContain('410 MB')
    expect(email.text).toContain('620 log & 380 pesan tertua dieliminasi')
    expect(email.text).toContain('Pesan terkirim   : 245')
    expect(email.html).toContain('410 MB / 400 MB')
    expect(email.html).toContain('620 log &amp; 380 pesan tertua dieliminasi')
  })
})
