// Muat library Supabase di latar belakang setelah halaman pertama tampil, supaya data pertama setelah login
// tidak menunggu unduhan (bundle awal sengaja tanpa library ini).
export default defineNuxtPlugin(() => {
  const preload = () => { loadSupabase().catch(() => undefined) }
  if ('requestIdleCallback' in window) window.requestIdleCallback(preload, { timeout: 3000 })
  else setTimeout(preload, 1500)
})
