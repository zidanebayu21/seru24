/**
 * Versi APK Android terbaru beserta link Google Drive-nya (publik, tanpa login).
 * Dipakai aplikasi untuk peringatan pembaruan dan menu web untuk link unduh. Hasil di-cache agar Drive tidak dipanggil tiap permintaan.
 */
import type { AppRelease } from '#shared/app-release'

const CACHE_MS = 60_000
let cached: { at: number; latest: AppRelease | null } | null = null

export default defineLoggedHandler(async (event) => {
  if (!cached || Date.now() - cached.at > CACHE_MS) {
    // tanpa Google Drive (NUXT_GDRIVE_*) belum ada rilis APK: jawab kosong, bukan error
    const drive = useRuntimeConfig(event).gdriveRefreshToken ? driveConfig(event) : null
    cached = { at: Date.now(), latest: drive ? await findApkRelease(drive) : null }
  }
  setResponseHeader(event, 'cache-control', 'public, max-age=60, s-maxage=300')
  return { latest: cached.latest }
})
