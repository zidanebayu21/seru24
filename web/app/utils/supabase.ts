import type { SupabaseClient } from '@supabase/supabase-js'

const VISITOR_KEY_STORAGE = 'seru24:visitor-key'

let client: SupabaseClient | null = null
let sdk: Promise<typeof import('@supabase/supabase-js')> | null = null
let visitorKey: string | null = null

/**
 * Penanda perangkat yang dikirim sebagai header x-visitor-key.
 * Server hanya menyimpan hash sha256-nya (tabel seru24.user_devices).
 */
export const getVisitorKey = (): string => {
  if (visitorKey) return visitorKey
  try {
    visitorKey = localStorage.getItem(VISITOR_KEY_STORAGE)
  } catch {
    visitorKey = null
  }
  if (!visitorKey || !/^[0-9a-f]{64}$/.test(visitorKey)) {
    const bytes = crypto.getRandomValues(new Uint8Array(32))
    visitorKey = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
    try {
      localStorage.setItem(VISITOR_KEY_STORAGE, visitorKey)
    } catch {
      // mode privat: kunci hanya berlaku selama tab terbuka
    }
  }
  return visitorKey
}

/** Library Supabase (+ realtime) cukup besar; dimuat saat pertama dibutuhkan, bukan di bundle awal (halaman login). */
export const loadSupabase = () => (sdk ??= import('@supabase/supabase-js'))

export const ensureSupabase = async (): Promise<SupabaseClient> => {
  if (!client) {
    const { createClient } = await loadSupabase()
    const { supabaseUrl, supabaseAnonKey } = useRuntimeConfig().public
    client ??= createClient(supabaseUrl, supabaseAnonKey, {
      accessToken: getAccessToken,
      global: { headers: { 'x-visitor-key': getVisitorKey() } },
    })
  }
  return client
}

/** Untuk kode sinkron yang berjalan setelah ensureSupabase() selesai (mis. realtime). */
export const useSupabase = (): SupabaseClient => {
  if (!client) throw new Error('Supabase belum dimuat')
  return client
}

/**
 * Semua akses data lewat fungsi public.seru24_*; tabel tidak dibuka ke API.
 * bearer: token khusus (mis. token pemulihan dari email) sebagai pengganti sesi aktif.
 */
export const rpc = async <T = unknown>(fn: string, args?: Record<string, unknown>, bearer?: string): Promise<T> => {
  const query = (await ensureSupabase()).rpc(fn, args)
  const { data, error } = await (bearer ? query.setHeader('Authorization', `Bearer ${bearer}`) : query)
  if (error) throw error
  return data as T
}
