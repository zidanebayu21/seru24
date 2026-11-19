import { voiceFileName } from '#shared/file-core'

// Pesan suara: direkam di browser (MediaRecorder), lalu dikirim lewat jalur dokumen terenkripsi yang sama.

export const MAX_VOICE_SECONDS = 300
const MIN_VOICE_SECONDS = 1
const MIME_CANDIDATES = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus', 'audio/mp4']

export const canRecordVoice = (): boolean =>
  typeof MediaRecorder !== 'undefined' && Boolean(navigator.mediaDevices?.getUserMedia)

const extensionOf = (mime: string) => (mime.includes('webm') ? 'webm' : mime.includes('ogg') ? 'ogg' : 'm4a')

export interface VoiceRecording {
  startedAt: number
  /** Berhenti dan hasilkan file; null bila terlalu pendek. */
  stop: () => Promise<File | null>
  cancel: () => void
}

/** Minta izin mikrofon lalu mulai merekam; onLimit dipanggil saat mencapai batas durasi. */
export const startVoiceRecording = async (onLimit: () => void): Promise<VoiceRecording> => {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } })
  const mimeType = MIME_CANDIDATES.find((type) => MediaRecorder.isTypeSupported(type)) ?? ''
  const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined)
  const chunks: Blob[] = []
  const startedAt = Date.now()
  recorder.ondataavailable = (event) => {
    if (event.data.size > 0) chunks.push(event.data)
  }
  const stopped = new Promise<void>((resolve) => { recorder.onstop = () => resolve() })
  const release = () => stream.getTracks().forEach((track) => track.stop())
  const limitTimer = setTimeout(onLimit, MAX_VOICE_SECONDS * 1000)
  recorder.start(250)

  const halt = async () => {
    clearTimeout(limitTimer)
    if (recorder.state !== 'inactive') recorder.stop()
    release()
    await stopped
  }

  return {
    startedAt,
    stop: async () => {
      await halt()
      const seconds = (Date.now() - startedAt) / 1000
      if (seconds < MIN_VOICE_SECONDS || chunks.length === 0) return null
      const type = (recorder.mimeType || mimeType || 'audio/webm').split(';')[0]!
      return new File(chunks, voiceFileName(seconds, extensionOf(type)), { type })
    },
    cancel: () => { void halt() },
  }
}
