// Mulai/berhenti mendengar pesan masuk untuk notifikasi desktop mengikuti status akun.
export default defineNuxtPlugin(() => {
  const router = useRouter()
  initNotifications()

  watch(
    () => account.status,
    (status) => {
      if (status === 'ready') {
        startNotifications(() => router.currentRoute.value.path, (id) => router.push(`/chats/${id}`))
      } else {
        stopNotifications()
      }
    },
    { immediate: true },
  )
})
