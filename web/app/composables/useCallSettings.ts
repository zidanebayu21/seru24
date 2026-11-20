import { loadAutoRecord, saveAutoRecord } from '#shared/call-record-core'

// Pengaturan telepon per perangkat (bukan rahasia): rekam otomatis setiap panggilan tersambung, bawaan mati.
export const useCallSettings = () => {
  const autoRecord = useState<boolean>('call-auto-record', () => false)

  /** Dipanggil di client: baca pilihan tersimpan dari perangkat ini. */
  const init = () => {
    autoRecord.value = loadAutoRecord(localStorage)
  }

  const setAutoRecord = (on: boolean) => {
    autoRecord.value = on
    saveAutoRecord(localStorage, on)
  }

  return { autoRecord, init, setAutoRecord }
}
