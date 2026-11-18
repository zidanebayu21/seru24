import net from 'node:net'
import tls from 'node:tls'

export interface SmtpConfig {
  host: string
  port: number
  secure: boolean
  user: string
  pass: string
  from: string
  to: string[]
}

export interface DailyStatsReport {
  day: string
  daily: {
    registrations: number
    logins_success: number
    logins_failed: number
    active_users: number
    messages_sent: number
    messages_rejected: number
    attachments_sent: number
    reports_opened: number
  }
  totals: {
    users: number
    conversations: number
    messages: number
    system_logs: number
    open_reports: number
  }
  storage: {
    db_size_bytes: number
    db_size_after_bytes: number
    db_size_mb: number
    limit_bytes: number
    limit_mb: number
    over_limit: boolean
    pruned: boolean
    pruned_logs: number
    pruned_messages: number
    deleted_expired_messages: number
    deleted_rate_limits: number
  }
}

const str = (value: unknown) => (typeof value === 'string' ? value.trim() : '')

export const escapeHtml = (value: unknown): string =>
  String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')

/** Baca konfigurasi SMTP dari runtimeConfig dan env; null bila host/tujuan belum diset. */
export const parseSmtpConfig = (
  raw: Record<string, unknown> = {},
  env: NodeJS.ProcessEnv = process.env,
): SmtpConfig | null => {
  const host = str(raw.smtpHost) || str(env.SMTP_HOST)
  if (!host) return null

  const portRaw = str(raw.smtpPort) || str(env.SMTP_PORT) || '587'
  const parsedPort = Number.parseInt(portRaw, 10)
  const port = Number.isFinite(parsedPort) && parsedPort > 0 ? parsedPort : 587

  const rawSecure = raw.smtpSecure ?? env.SMTP_SECURE
  const secure =
    rawSecure !== undefined && String(rawSecure).trim() !== ''
      ? String(rawSecure).trim().toLowerCase() === 'true'
      : port === 465

  const user = str(raw.smtpUser) || str(env.SMTP_USER)
  const pass = str(raw.smtpPass) || str(env.SMTP_PASS)
  const from = str(raw.smtpFrom) || str(env.SMTP_FROM) || user || 'seru24 <noreply@seru24.local>'
  const targetRaw = str(raw.smtpTargetEmail) || str(env.SMTP_TARGET_EMAIL) || user
  const to = targetRaw
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)

  if (to.length === 0) return null
  return { host, port, secure, user, pass, from, to }
}

/** Susun subjek, teks polos, dan HTML laporan penggunaan harian & status kapasitas DB Supabase. */
export const buildDailyStatsEmail = (report: DailyStatsReport, now = new Date()) => {
  const tanggal = new Intl.DateTimeFormat('id-ID', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: 'Asia/Jakarta',
  }).format(now)
  const jam = new Intl.DateTimeFormat('id-ID', {
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'Asia/Jakarta',
  }).format(now)

  const pct = report.storage.limit_mb > 0
    ? Math.min(999, Math.round((report.storage.db_size_mb / report.storage.limit_mb) * 1000) / 10)
    : 0

  const pruneNote = report.storage.pruned
    ? `Batas ${report.storage.limit_mb} MB tercapai: ${report.storage.pruned_logs} log & ${report.storage.pruned_messages} pesan tertua dieliminasi.`
    : report.storage.over_limit
      ? `Batas ${report.storage.limit_mb} MB tercapai, namun tidak ada baris log/pesan tersisa untuk dipangkas.`
      : `Kapasitas aman di bawah batas ${report.storage.limit_mb} MB (${pct}%).`

  const subject = `📊 Statistik Harian seru24 (${report.day}) — DB ${report.storage.db_size_mb} MB`

  const text = [
    `Laporan Harian seru24 — ${tanggal} (${jam} WIB)`,
    `Tanggal rekap: ${report.day}`,
    '',
    `Kapasitas DB Supabase: ${report.storage.db_size_mb} MB / ${report.storage.limit_mb} MB (${pct}%)`,
    `Status retensi: ${pruneNote}`,
    `Pembersihan rutin: ${report.storage.deleted_expired_messages} pesan kedaluwarsa, ${report.storage.deleted_rate_limits} rate limit usang`,
    '',
    'Statistik Harian:',
    `- Pendaftaran baru : ${report.daily.registrations}`,
    `- Login sukses     : ${report.daily.logins_success}`,
    `- Login gagal      : ${report.daily.logins_failed}`,
    `- Pengguna aktif   : ${report.daily.active_users}`,
    `- Pesan terkirim   : ${report.daily.messages_sent}`,
    `- Pesan ditolak    : ${report.daily.messages_rejected}`,
    `- Lampiran         : ${report.daily.attachments_sent}`,
    `- Laporan masuk    : ${report.daily.reports_opened}`,
    '',
    'Total Saat Ini:',
    `- Pengguna         : ${report.totals.users}`,
    `- Percakapan       : ${report.totals.conversations}`,
    `- Pesan di server  : ${report.totals.messages}`,
    `- System logs      : ${report.totals.system_logs}`,
    `- Laporan terbuka  : ${report.totals.open_reports}`,
  ].join('\n')

  const row = (label: string, value: number | string) =>
    `<tr><td style="padding:8px 12px;border-bottom:1px solid #e2e8f0;color:#475569;">${escapeHtml(label)}</td><td style="padding:8px 12px;border-bottom:1px solid #e2e8f0;text-align:right;font-weight:600;color:#0f172a;">${escapeHtml(value)}</td></tr>`

  const statusBg = report.storage.over_limit ? '#fef3c7' : '#ecfdf5'
  const statusBorder = report.storage.over_limit ? '#d97706' : '#0f766e'

  const html = `
<div style="font-family:Arial,sans-serif;max-width:680px;margin:0 auto;padding:20px;background:#ffffff;color:#1e293b;border:1px solid #e2e8f0;border-radius:10px;">
  <div style="background:#0f766e;color:#ffffff;padding:18px 22px;border-radius:8px 8px 0 0;">
    <h2 style="margin:0;font-size:20px;">📊 Statistik Penggunaan Harian seru24</h2>
    <p style="margin:4px 0 0 0;font-size:13px;opacity:0.9;">${escapeHtml(tanggal)} · ${escapeHtml(jam)} WIB · Rekap ${escapeHtml(report.day)}</p>
  </div>
  <div style="padding:18px 6px;">
    <div style="background:${statusBg};border-left:4px solid ${statusBorder};padding:12px 14px;border-radius:0 6px 6px 0;margin-bottom:18px;font-size:14px;">
      <strong>Kapasitas DB Supabase:</strong> ${escapeHtml(report.storage.db_size_mb)} MB / ${escapeHtml(report.storage.limit_mb)} MB (${escapeHtml(pct)}%)<br>
      <span>${escapeHtml(pruneNote)}</span><br>
      <span style="font-size:12px;color:#475569;">Pembersihan rutin: ${escapeHtml(report.storage.deleted_expired_messages)} pesan kedaluwarsa · ${escapeHtml(report.storage.deleted_rate_limits)} rate limit lama.</span>
    </div>

    <h3 style="margin:0 0 8px 0;font-size:16px;color:#0f172a;">Aktivitas Hari Ini</h3>
    <table style="width:100%;border-collapse:collapse;font-size:14px;margin-bottom:20px;">
      ${row('Pendaftaran baru', report.daily.registrations)}
      ${row('Login sukses', report.daily.logins_success)}
      ${row('Login gagal', report.daily.logins_failed)}
      ${row('Pengguna aktif', report.daily.active_users)}
      ${row('Pesan terkirim', report.daily.messages_sent)}
      ${row('Pesan ditolak', report.daily.messages_rejected)}
      ${row('Lampiran terkirim', report.daily.attachments_sent)}
      ${row('Laporan pengguna baru', report.daily.reports_opened)}
    </table>

    <h3 style="margin:0 0 8px 0;font-size:16px;color:#0f172a;">Ringkasan Database Saat Ini</h3>
    <table style="width:100%;border-collapse:collapse;font-size:14px;">
      ${row('Total pengguna', report.totals.users)}
      ${row('Total percakapan', report.totals.conversations)}
      ${row('Pesan tersimpan di Supabase', report.totals.messages)}
      ${row('Baris system_logs', report.totals.system_logs)}
      ${row('Laporan berstatus open', report.totals.open_reports)}
    </table>
  </div>
  <div style="background:#f8fafc;padding:10px;text-align:center;font-size:12px;color:#64748b;border-radius:0 0 8px 8px;">
    Dikirim otomatis oleh endpoint /api/cron/daily-stats seru24
  </div>
</div>`.trim()

  return { subject, text, html }
}

const extractAddress = (input: string) => {
  const match = /<([^>]+)>/.exec(input)
  return (match?.[1] ?? input).trim()
}

const chunkBase64 = (text: string) =>
  Buffer.from(text, 'utf8').toString('base64').replace(/(.{76})/g, '$1\r\n')

const buildMimePayload = (from: string, to: string[], subject: string, text: string, html: string) => {
  const boundary = `seru24_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`
  const encodedSubject = `=?UTF-8?B?${Buffer.from(subject, 'utf8').toString('base64')}?=`
  return [
    `From: ${from}`,
    `To: ${to.join(', ')}`,
    `Subject: ${encodedSubject}`,
    `Date: ${new Date().toUTCString()}`,
    'MIME-Version: 1.0',
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
    '',
    `--${boundary}`,
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    '',
    chunkBase64(text),
    '',
    `--${boundary}`,
    'Content-Type: text/html; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    '',
    chunkBase64(html),
    '',
    `--${boundary}--`,
    '.',
  ].join('\r\n')
}

interface SmtpResponse {
  code: number
  lines: string[]
}

const createReader = (socket: net.Socket | tls.TLSSocket) => {
  let buffer = ''
  const queue: SmtpResponse[] = []
  let waiting: ((res: SmtpResponse) => void) | null = null
  let rejecter: ((err: Error) => void) | null = null
  let currentLines: string[] = []

  const onData = (chunk: Buffer | string) => {
    buffer += typeof chunk === 'string' ? chunk : chunk.toString('utf8')
    let idx = buffer.indexOf('\n')
    while (idx >= 0) {
      const line = buffer.slice(0, idx).replace(/\r$/, '')
      buffer = buffer.slice(idx + 1)
      if (/^\d{3}[ -]/.test(line)) {
        currentLines.push(line)
        if (line[3] === ' ') {
          const res: SmtpResponse = { code: Number.parseInt(line.slice(0, 3), 10), lines: currentLines }
          currentLines = []
          if (waiting) {
            const resolve = waiting
            waiting = null
            rejecter = null
            resolve(res)
          } else {
            queue.push(res)
          }
        }
      }
      idx = buffer.indexOf('\n')
    }
  }

  const onError = (err: Error) => {
    if (rejecter) {
      const reject = rejecter
      waiting = null
      rejecter = null
      reject(err)
    }
  }

  const onClose = () => onError(new Error('Koneksi SMTP ditutup sebelum selesai'))

  const attach = (target: net.Socket | tls.TLSSocket) => {
    target.on('data', onData)
    target.on('error', onError)
    target.on('close', onClose)
  }

  const detach = (target: net.Socket | tls.TLSSocket) => {
    target.off('data', onData)
    target.off('error', onError)
    target.off('close', onClose)
  }

  attach(socket)

  const nextResponse = () =>
    queue.length > 0
      ? Promise.resolve(queue.shift()!)
      : new Promise<SmtpResponse>((resolve, reject) => {
          waiting = resolve
          rejecter = reject
        })

  const command = async (cmd: string, expectedCodes: number[]) => {
    socket.write(`${cmd}\r\n`)
    const res = await nextResponse()
    if (!expectedCodes.includes(res.code)) {
      throw new Error(`SMTP error (${res.code}): ${res.lines.join(' | ')}`)
    }
    return res
  }

  const rebind = (nextSocket: net.Socket | tls.TLSSocket) => {
    detach(socket)
    socket = nextSocket
    attach(socket)
  }

  return { nextResponse, command, rebind, getSocket: () => socket }
}

/** Kirim email lewat SMTP (mendukung TLS langsung port 465 maupun STARTTLS port 587). */
export const sendSmtpMail = async (
  config: SmtpConfig,
  mail: { subject: string; text: string; html: string },
): Promise<{ ok: true; response: string }> => {
  const timeoutMs = 15_000
  const baseSocket: net.Socket | tls.TLSSocket = await new Promise((resolve, reject) => {
    const conn = config.secure
      ? tls.connect({ host: config.host, port: config.port, servername: config.host })
      : net.connect({ host: config.host, port: config.port })
    conn.setTimeout(timeoutMs, () => conn.destroy(new Error('Koneksi SMTP timeout')))
    conn.once('error', reject)
    conn.once(config.secure ? 'secureConnect' : 'connect', () => {
      conn.off('error', reject)
      resolve(conn)
    })
  })

  const reader = createReader(baseSocket)
  try {
    const greeting = await reader.nextResponse()
    if (greeting.code !== 220) {
      throw new Error(`SMTP greeting gagal (${greeting.code})`)
    }

    let ehlo = await reader.command('EHLO seru24.local', [250])
    const supportsStartTls = ehlo.lines.some((line) => /STARTTLS/i.test(line))

    if (!config.secure && supportsStartTls) {
      await reader.command('STARTTLS', [220])
      const upgraded = await new Promise<tls.TLSSocket>((resolve, reject) => {
        const tlsSock = tls.connect({ socket: reader.getSocket(), servername: config.host })
        tlsSock.setTimeout(timeoutMs, () => tlsSock.destroy(new Error('SMTP TLS timeout')))
        tlsSock.once('error', reject)
        tlsSock.once('secureConnect', () => {
          tlsSock.off('error', reject)
          resolve(tlsSock)
        })
      })
      reader.rebind(upgraded)
      ehlo = await reader.command('EHLO seru24.local', [250])
    }

    if (config.user && config.pass) {
      await reader.command('AUTH LOGIN', [334])
      await reader.command(Buffer.from(config.user, 'utf8').toString('base64'), [334])
      await reader.command(Buffer.from(config.pass, 'utf8').toString('base64'), [235])
    }

    await reader.command(`MAIL FROM:<${extractAddress(config.from)}>`, [250])
    for (const recipient of config.to) {
      await reader.command(`RCPT TO:<${extractAddress(recipient)}>`, [250, 251])
    }
    await reader.command('DATA', [354])
    const payload = buildMimePayload(config.from, config.to, mail.subject, mail.text, mail.html)
    const sent = await reader.command(payload, [250])
    await reader.command('QUIT', [221, 250]).catch(() => undefined)
    return { ok: true, response: sent.lines.join(' ') }
  } finally {
    reader.getSocket().destroy()
  }
}
