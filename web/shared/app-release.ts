// Info rilis APK Android terbaru (diunggah release_apk.ps1 ke Google Drive), dipakai server, web, dan mobile.

export type AppVariant = 'react' | 'rust'

export interface AppRelease {
  versionCode: number
  versionName: string
  /** Link Google Drive yang sama untuk setiap rilis (dibuka di browser). */
  url: string
  /** Unduhan langsung isi APK, untuk pembaruan dari dalam aplikasi. */
  downloadUrl: string
  /** SHA-256 (hex) APK; aplikasi menolak memasang file yang tidak cocok (OWASP ASVS V10.3.2). */
  sha256: string
  sizeBytes: number
  updatedAt: string
  /** Penanda kanal APK ('react' = seru24.apk, 'rust' = seru24-rust.apk). */
  variant?: AppVariant
}

const DRIVE_LINK = /^https:\/\/drive\.google\.com\/file\/d\/[\w-]{10,100}\/view$/
const DRIVE_DOWNLOAD = /^https:\/\/drive\.usercontent\.google\.com\/download\?id=[\w-]{10,100}&export=download&confirm=t$/
const SHA256_HEX = /^[0-9a-f]{64}$/

/** Link Drive untuk file id tertentu: halaman lihat dan unduhan langsung. */
export const driveLinks = (fileId: string) => ({
  url: `https://drive.google.com/file/d/${fileId}/view`,
  downloadUrl: `https://drive.usercontent.google.com/download?id=${fileId}&export=download&confirm=t`,
})

/** Validasi data dari /api/app/latest; null bila tidak ada rilis atau bentuknya tidak sesuai. */
export const parseAppRelease = (value: unknown): AppRelease | null => {
  if (!value || typeof value !== 'object') return null
  const r = value as Record<string, unknown>
  if (typeof r.versionCode !== 'number' || !Number.isInteger(r.versionCode) || r.versionCode < 1) return null
  if (typeof r.versionName !== 'string' || !/^[\w.-]{1,20}$/.test(r.versionName)) return null
  if (typeof r.url !== 'string' || !DRIVE_LINK.test(r.url)) return null
  if (typeof r.downloadUrl !== 'string' || !DRIVE_DOWNLOAD.test(r.downloadUrl)) return null
  if (typeof r.sha256 !== 'string' || !SHA256_HEX.test(r.sha256)) return null
  const variant = r.variant === 'react' || r.variant === 'rust' ? r.variant : undefined
  if (r.variant !== undefined && !variant) return null
  return {
    versionCode: r.versionCode,
    versionName: r.versionName,
    url: r.url,
    downloadUrl: r.downloadUrl,
    sha256: r.sha256,
    sizeBytes: typeof r.sizeBytes === 'number' ? r.sizeBytes : 0,
    updatedAt: typeof r.updatedAt === 'string' ? r.updatedAt : '',
    ...(variant ? { variant } : {}),
  }
}

export const isNewerRelease = (latest: AppRelease | null, currentVersionCode: number): latest is AppRelease =>
  Boolean(latest && latest.versionCode > currentVersionCode)
