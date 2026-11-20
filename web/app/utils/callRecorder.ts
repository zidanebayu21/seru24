import { pickRecorderMime, recordingFileName } from '#shared/call-record-core'

/**
 * Merekam panggilan: suara kita dan lawan dicampur jadi satu berkas, lalu diunduh saat rekaman berhenti.
 * Semuanya di browser ini; tidak ada yang dikirim ke server.
 */
export const startCallRecording = (local: MediaStream, remote: MediaStream, peerName: string) => {
  const context = new AudioContext()
  const mix = context.createMediaStreamDestination()
  context.createMediaStreamSource(local).connect(mix)
  context.createMediaStreamSource(remote).connect(mix)

  const mime = pickRecorderMime((type) => MediaRecorder.isTypeSupported(type))
  const recorder = new MediaRecorder(mix.stream, mime ? { mimeType: mime } : undefined)
  const chunks: Blob[] = []
  recorder.ondataavailable = ({ data }) => { if (data.size > 0) chunks.push(data) }

  const finished = new Promise<void>((resolve) => {
    recorder.onstop = () => {
      void context.close().catch(() => undefined)
      if (chunks.length > 0) {
        const type = recorder.mimeType || mime || 'audio/webm'
        const url = URL.createObjectURL(new Blob(chunks, { type }))
        const link = document.createElement('a')
        link.href = url
        link.download = recordingFileName(peerName, type)
        link.click()
        setTimeout(() => URL.revokeObjectURL(url), 10_000)
      }
      resolve()
    }
  })
  recorder.start(1000)

  return {
    /** Hentikan rekaman dan unduh berkasnya. */
    stop: () => {
      if (recorder.state !== 'inactive') recorder.stop()
      return finished
    },
  }
}
