import { describe, expect, it } from 'vitest'
import {
  buildDailyStatsEmail,
  buildMimePayload,
  extractAddress,
  fileReportRows,
  formatStorage,
  parseSmtpConfig,
  type DailyStatsReport,
} from '../../../server/utils/smtp'

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

  it('merangkum dokumen Google Drive di laporan', () => {
    expect(formatStorage(52_428_800)).toBe('50.0 MB')
    expect(formatStorage(3 * 1024 ** 3)).toBe('3.00 GB')
    expect(fileReportRows({
      files: 4, bytes: 60 * 1024 ** 2, cleaned: 2, cleanupFailed: 1,
      driveUsageBytes: 2 * 1024 ** 3, driveLimitBytes: 5 * 1024 ** 4,
    })).toEqual([
      ['Dokumen tersimpan', '4 file · 60.0 MB'],
      ['Pemakaian akun Google Drive', '2.00 GB / 5120.00 GB'],
      ['Dokumen yatim dibersihkan', '2 (gagal 1)'],
    ])
    expect(fileReportRows(null)[0]![0]).toBe('Dokumen')
  })

  it('mengekstrak alamat email dan menyusun payload MIME multipart', () => {
    expect(extractAddress('bot@example.com')).toBe('bot@example.com')
    expect(extractAddress('Seru24 Bot <bot@example.com>')).toBe('bot@example.com')

    const mime = buildMimePayload('from@example.com', ['to@example.com'], 'Test Subject', 'Plain text', '<p>Html text</p>')
    expect(mime).toContain('From: from@example.com')
    expect(mime).toContain('To: to@example.com')
    expect(mime).toContain('multipart/alternative')
    expect(mime).toContain('Content-Type: text/plain')
    expect(mime).toContain('Content-Type: text/html')
  })

  it('mengirim email SMTP lewat soket TCP mock', async () => {
    const net = await import('node:net')
    const { sendSmtpMail } = await import('../../../server/utils/smtp')

    const server = net.createServer((socket) => {
      socket.write('220 mock-smtp-server ready\r\n')
      socket.on('data', (chunk) => {
        const text = chunk.toString('utf8')
        if (text.startsWith('EHLO')) {
          socket.write('250-mock\r\n250 OK\r\n')
        } else if (text.startsWith('MAIL FROM:')) {
          socket.write('250 Sender OK\r\n')
        } else if (text.startsWith('RCPT TO:')) {
          socket.write('250 Recipient OK\r\n')
        } else if (text.startsWith('DATA')) {
          socket.write('354 Go ahead\r\n')
        } else if (text.includes('\r\n.\r\n')) {
          socket.write('250 Message accepted for delivery\r\n')
        } else if (text.startsWith('QUIT')) {
          socket.write('221 Bye\r\n')
          socket.end()
        }
      })
    })

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const addr = server.address() as net.AddressInfo

    const config = {
      host: '127.0.0.1',
      port: addr.port,
      secure: false,
      user: '',
      pass: '',
      from: 'sender@example.com',
      to: ['recipient@example.com'],
    }

    try {
      const res = await sendSmtpMail(config, {
        subject: 'Test Subject',
        text: 'Test Body',
        html: '<p>Test Body</p>',
      })
      expect(res.ok).toBe(true)
      expect(res.response).toContain('250 Message accepted')
    } finally {
      server.close()
    }
  })
})
