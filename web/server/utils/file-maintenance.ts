/**
 * Perawatan dokumen untuk cron Senin & Kamis: hapus file yatim (upload terputus, atau file yang tidak lagi dipakai
 * pesan aktif) dari Google Drive dan database, lalu rekap pemakaian dokumen dan kuota Drive untuk email laporan.
 */
import type { H3Event } from 'h3'
import type { DriveConfig } from './gdrive'

export interface FileMaintenance {
  /** Dokumen tersimpan (status ready). */
  files: number
  bytes: number
  /** Dokumen yatim yang dibersihkan pada jalan ini (atau calon bila dryRun). */
  cleaned: number
  cleanupFailed: number
  driveUsageBytes: number | null
  driveLimitBytes: number | null
}

const tryDriveConfig = (event: H3Event): DriveConfig | null => {
  try {
    return driveConfig(event)
  } catch {
    return null
  }
}

export const runFileMaintenance = async (event: H3Event, dryRun: boolean): Promise<FileMaintenance> => {
  const drive = tryDriveConfig(event)
  const candidates = (await fileRpc<Array<{ id: string; drive_file_id: string | null }> | null>(
    event, 'seru24_file_cleanup_candidates', { p_limit: 200 },
  )) ?? []

  let cleaned = dryRun ? candidates.length : 0
  let cleanupFailed = 0
  if (!dryRun && candidates.length > 0) {
    const done: string[] = []
    for (const item of candidates) {
      // tanpa kredensial Drive, file yang sudah ada di Drive tidak ditandai bersih agar tidak tertinggal di Drive
      if (item.drive_file_id && !drive) {
        cleanupFailed += 1
        continue
      }
      try {
        if (item.drive_file_id && drive) await deleteDriveFile(drive, item.drive_file_id)
        done.push(item.id)
      } catch {
        cleanupFailed += 1
      }
    }
    if (done.length > 0) cleaned = await fileRpc<number>(event, 'seru24_file_mark_cleaned', { p_ids: done })
  }

  const usage = await fileRpc<{ files: number; bytes: number }>(event, 'seru24_file_usage', {})
  const quota = drive ? await driveQuota(drive).catch(() => null) : null
  return {
    files: Number(usage.files) || 0,
    bytes: Number(usage.bytes) || 0,
    cleaned,
    cleanupFailed,
    driveUsageBytes: quota?.usage ?? null,
    driveLimitBytes: quota?.limit ?? null,
  }
}
