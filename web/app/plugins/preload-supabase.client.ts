// Muat library Supabase di latar belakang setelah halaman pertama tampil, supaya data pertama setelah login
// tidak menunggu unduhan (bundle awal sengaja tanpa library ini). Koneksi ke Supabase juga dibuka lebih awal
// (preconnect) agar DNS dan TLS tidak menambah waktu pada panggilan data pertama.
export default defineNuxtPlugin(() => {
  const { supabaseUrl } = useRuntimeConfig().public
  if (supabaseUrl) useHead({ link: [{ rel: 'preconnect', href: supabaseUrl, crossorigin: '' }] })

  const preload = () => { loadSupabase().catch(() => undefined) }
  if ('requestIdleCallback' in window) window.requestIdleCallback(preload, { timeout: 3000 })
  else setTimeout(preload, 1500)
})
