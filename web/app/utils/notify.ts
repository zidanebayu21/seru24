// Notifikasi desktop (Windows/macOS) lewat Notification API browser, selama tab seru24 terbuka.
// Isi pesan tidak pernah ditampilkan (terenkripsi; layar kunci/notifikasi bisa dilihat orang lain).

const PREF_KEY = 'seru24:notifications'

export const notifyState = reactive({
  supported: false,
  enabled: false,
  permission: 'default' as NotificationPermission,
})

let unsubscribe: (() => void) | null = null

const readPref = () => {
  try {
    return localStorage.getItem(PREF_KEY) === 'on'
  } catch {
    return false
  }
}

const writePref = (on: boolean) => {
  try {
    localStorage.setItem(PREF_KEY, on ? 'on' : 'off')
  } catch {
    // mode privat: pilihan hanya berlaku selama tab terbuka
  }
}

export const initNotifications = () => {
  notifyState.supported = typeof window !== 'undefined' && 'Notification' in window
  if (!notifyState.supported) return
  notifyState.permission = Notification.permission
  notifyState.enabled = readPref() && Notification.permission === 'granted'
}

/** Minta izin browser bila belum; false bila pengguna menolak atau browser tidak mendukung. */
export const enableNotifications = async () => {
  if (!notifyState.supported) return false
  notifyState.permission = Notification.permission === 'default'
    ? await Notification.requestPermission()
    : Notification.permission
  notifyState.enabled = notifyState.permission === 'granted'
  writePref(notifyState.enabled)
  return notifyState.enabled
}

export const disableNotifications = () => {
  notifyState.enabled = false
  writePref(false)
}

/** Dengarkan pesan masuk; dipanggil saat akun siap. openConversation = navigasi ke percakapan. */
export const startNotifications = (currentPath: () => string, openConversation: (id: string) => void) => {
  if (unsubscribe || !notifyState.supported) return
  unsubscribe = onInbox((event, payload) => {
    if (event !== 'message_new' || !notifyState.enabled || payload.sender_id === account.me?.id) return
    const conversationId = String(payload.conversation_id)
    // sedang membuka percakapan itu di tab aktif: tidak perlu notifikasi
    if (!document.hidden && currentPath() === `/chats/${conversationId}`) return

    const notification = new Notification('seru24', { body: 'Pesan baru', tag: conversationId, icon: '/favicon.ico' })
    notification.onclick = () => {
      window.focus()
      openConversation(conversationId)
      notification.close()
    }
  })
}

export const stopNotifications = () => {
  unsubscribe?.()
  unsubscribe = null
}

/** Beri tahu server untuk mengirim push FCM ke HP penerima (best-effort, tidak menahan alur kirim). */
export const notifyMessageSent = (conversationId: string, messageId: string) => {
  getAccessToken()
    .then((token) =>
      token ? secureFetch('/api/push/notify', { access_token: token, conversation_id: conversationId, message_id: messageId }) : undefined,
    )
    .catch(() => undefined)
}
