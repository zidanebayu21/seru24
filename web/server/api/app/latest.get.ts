/**
 * Versi APK Android terbaru beserta link Google Drive-nya (publik, tanpa login).
 * Query ?app=rust mengembalikan rilis Rust (seru24-rust.apk); default/react mengembalikan seru24.apk yang sudah ada.
 */
import type { AppRelease, AppVariant } from '#shared/app-release'

const CACHE_MS = 60_000
const cached = new Map<AppVariant, { at: number; latest: AppRelease | null }>()

export default defineLoggedHandler(async (event) => {
  const variant: AppVariant = getQuery(event).app === 'rust' ? 'rust' : 'react'
  const hit = cached.get(variant)
  if (!hit || Date.now() - hit.at > CACHE_MS) {
    // tanpa Google Drive (NUXT_GDRIVE_*) belum ada rilis APK: jawab kosong, bukan error
    const drive = useRuntimeConfig(event).gdriveRefreshToken ? driveConfig(event) : null
    cached.set(variant, { at: Date.now(), latest: drive ? await findApkRelease(drive, variant) : null })
  }
  setResponseHeader(event, 'cache-control', 'public, max-age=60, s-maxage=300')
  return { latest: cached.get(variant)?.latest ?? null }
})
