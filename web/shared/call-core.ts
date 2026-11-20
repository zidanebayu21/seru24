// Telepon suara 1-ke-1 (WebRTC), bersama web dan mobile.
// Signaling lewat broadcast event "call" di channel privat "conv:<id>" (lihat presence-core); media langsung P2P
// (terenkripsi DTLS-SRTP), hanya memakai STUN publik: panggilan di balik NAT ketat/CGNAT bisa gagal tanpa TURN.

export const CALL_EVENT = 'call'
export const CALL_RING_TIMEOUT_MS = 45_000

// Tipe struktural minimal (bukan tipe DOM) agar bisa dipakai di web (DOM) dan React Native (react-native-webrtc).
export interface IceServer { urls: string | string[]; username?: string; credential?: string }
export interface IceCandidate { candidate?: string; sdpMid?: string | null; sdpMLineIndex?: number | null; usernameFragment?: string | null }
interface SessionDescription { type: 'offer' | 'answer'; sdp?: string }
export interface MicTrack { enabled: boolean; stop: () => void }
export interface MicStream { getTracks: () => MicTrack[]; getAudioTracks: () => MicTrack[] }
export interface PeerLike {
  connectionState: string
  signalingState: string
  remoteDescription: unknown
  onicecandidate: ((event: { candidate: { toJSON: () => IceCandidate } | null }) => void) | null
  ontrack: ((event: { streams: readonly MicStream[] }) => void) | null
  onconnectionstatechange: (() => void) | null
  addTrack: (track: MicTrack, stream: MicStream) => unknown
  addIceCandidate: (candidate: IceCandidate) => Promise<void>
  createOffer: () => Promise<SessionDescription>
  createAnswer: () => Promise<SessionDescription>
  setLocalDescription: (description: SessionDescription) => Promise<void>
  setRemoteDescription: (description: SessionDescription) => Promise<void>
  close: () => void
}

export const DEFAULT_ICE_SERVERS: IceServer[] = [
  { urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] },
]

export type CallPhase = 'idle' | 'calling' | 'incoming' | 'connecting' | 'connected'
export type CallEndReason = 'hangup' | 'rejected' | 'busy' | 'timeout' | 'failed' | 'mic-denied'

export interface CallSignal {
  type: 'invite' | 'accept' | 'reject' | 'busy' | 'offer' | 'answer' | 'ice' | 'hangup' | 'record'
  callId: string
  from: string
  sdp?: string
  candidate?: IceCandidate
  /** Untuk type 'record': true saat pihak pengirim mulai merekam panggilan (secara lokal), false saat berhenti. */
  on?: boolean
}

export interface CallDeps {
  myId: string
  send: (signal: CallSignal) => void
  onPhase: (phase: CallPhase) => void
  onRemoteStream: (stream: MicStream | null) => void
  onEnd: (reason: CallEndReason) => void
  /** Lawan bicara mulai/berhenti merekam panggilan di perangkatnya; pengguna wajib diberi tahu. */
  onPeerRecording?: (on: boolean) => void
  newCallId: () => string
  iceServers?: IceServer[]
  getMic?: () => Promise<MicStream>
  createPeer?: (config: { iceServers: IceServer[] }) => PeerLike
}

// Bawaan browser; di React Native getMic dan createPeer diberikan oleh adaptor react-native-webrtc.
const browser = globalThis as unknown as {
  navigator: { mediaDevices: { getUserMedia: (constraints: object) => Promise<MicStream> } }
  RTCPeerConnection: new (config: { iceServers: IceServer[] }) => PeerLike
}
const defaultMic = () => browser.navigator.mediaDevices.getUserMedia({ audio: true, video: false })

export const createCallController = (deps: CallDeps) => {
  const getMic = deps.getMic ?? defaultMic
  const createPeer = deps.createPeer ?? ((config) => new browser.RTCPeerConnection(config))

  let phase: CallPhase = 'idle'
  let callId = ''
  let pc: PeerLike | null = null
  let mic: MicStream | null = null
  let ringTimer: ReturnType<typeof setTimeout> | undefined
  let pendingIce: IceCandidate[] = []

  const setPhase = (next: CallPhase) => {
    phase = next
    deps.onPhase(next)
  }

  const emit = (type: CallSignal['type'], extra: Partial<CallSignal> = {}) =>
    deps.send({ type, callId, from: deps.myId, ...extra })

  /** Bersihkan semua sumber daya; sinyal ke lawan dikirim pemanggil fungsi ini bila perlu. */
  const teardown = (reason: CallEndReason) => {
    clearTimeout(ringTimer)
    pc?.close()
    pc = null
    mic?.getTracks().forEach((track) => track.stop())
    mic = null
    pendingIce = []
    const wasActive = phase !== 'idle'
    callId = ''
    deps.onRemoteStream(null)
    deps.onPeerRecording?.(false)
    setPhase('idle')
    if (wasActive) deps.onEnd(reason)
  }

  /** Penerima berhenti diam-diam (panggilan tak terjawab); pemanggil punya timer sendiri dan memberi tahu lawan. */
  const armRingTimeout = (notifyPeer: boolean) => {
    clearTimeout(ringTimer)
    ringTimer = setTimeout(() => {
      if (notifyPeer) emit('hangup')
      teardown('timeout')
    }, CALL_RING_TIMEOUT_MS)
  }

  const openMic = async (): Promise<boolean> => {
    try {
      mic = await getMic()
      return true
    } catch {
      return false
    }
  }

  const buildPeer = () => {
    pc = createPeer({ iceServers: deps.iceServers ?? DEFAULT_ICE_SERVERS })
    mic?.getTracks().forEach((track) => pc!.addTrack(track, mic!))
    pc.onicecandidate = ({ candidate }) => {
      if (candidate) emit('ice', { candidate: candidate.toJSON() })
    }
    pc.ontrack = ({ streams }) => deps.onRemoteStream(streams[0] ?? null)
    pc.onconnectionstatechange = () => {
      if (!pc) return
      if (pc.connectionState === 'connected') {
        clearTimeout(ringTimer)
        setPhase('connected')
      } else if (pc.connectionState === 'failed') {
        emit('hangup')
        teardown('failed')
      }
    }
    return pc
  }

  const flushIce = async () => {
    const queued = pendingIce
    pendingIce = []
    for (const candidate of queued) await pc?.addIceCandidate(candidate).catch(() => undefined)
  }

  /** Pemanggil: kirim undangan, tunggu lawan menerima. */
  const start = async () => {
    if (phase !== 'idle') return
    callId = deps.newCallId()
    setPhase('calling')
    if (!(await openMic())) {
      teardown('mic-denied')
      return
    }
    emit('invite')
    armRingTimeout(true)
  }

  /** Penerima: terima panggilan masuk, lalu pemanggil mengirim offer. */
  const accept = async () => {
    if (phase !== 'incoming') return
    setPhase('connecting')
    if (!(await openMic())) {
      emit('reject')
      teardown('mic-denied')
      return
    }
    clearTimeout(ringTimer)
    emit('accept')
  }

  const reject = () => {
    if (phase !== 'incoming') return
    emit('reject')
    teardown('rejected')
  }

  const hangup = () => {
    if (phase === 'idle') return
    emit('hangup')
    teardown('hangup')
  }

  const onInvite = (signal: CallSignal) => {
    if (phase !== 'idle') {
      deps.send({ type: 'busy', callId: signal.callId, from: deps.myId })
      return
    }
    callId = signal.callId
    setPhase('incoming')
    armRingTimeout(false)
  }

  const onAccept = async () => {
    if (phase !== 'calling') return
    clearTimeout(ringTimer)
    setPhase('connecting')
    const peer = buildPeer()
    const offer = await peer.createOffer()
    await peer.setLocalDescription(offer)
    emit('offer', { sdp: offer.sdp })
  }

  const onOffer = async (signal: CallSignal) => {
    if (phase !== 'connecting' || pc || !signal.sdp) return
    const peer = buildPeer()
    await peer.setRemoteDescription({ type: 'offer', sdp: signal.sdp })
    await flushIce()
    const answer = await peer.createAnswer()
    await peer.setLocalDescription(answer)
    emit('answer', { sdp: answer.sdp })
  }

  const onAnswer = async (signal: CallSignal) => {
    if (!pc || !signal.sdp || pc.signalingState !== 'have-local-offer') return
    await pc.setRemoteDescription({ type: 'answer', sdp: signal.sdp })
    await flushIce()
  }

  const onIce = async (signal: CallSignal) => {
    if (!signal.candidate || phase === 'idle') return
    if (pc?.remoteDescription) await pc.addIceCandidate(signal.candidate).catch(() => undefined)
    else pendingIce.push(signal.candidate)
  }

  /** Masukkan sinyal dari lawan; sinyal sendiri, panggilan lain, atau yang tidak valid diabaikan. */
  const handleSignal = async (signal: CallSignal) => {
    if (!signal || signal.from === deps.myId || typeof signal.callId !== 'string') return
    if (signal.type === 'invite') return onInvite(signal)
    if (phase === 'idle' || signal.callId !== callId) return
    try {
      switch (signal.type) {
        case 'accept': return await onAccept()
        case 'offer': return await onOffer(signal)
        case 'answer': return await onAnswer(signal)
        case 'ice': return await onIce(signal)
        case 'reject': return teardown('rejected')
        case 'busy': return teardown('busy')
        case 'hangup': return teardown('hangup')
        case 'record': return deps.onPeerRecording?.(signal.on === true)
      }
    } catch {
      emit('hangup')
      teardown('failed')
    }
  }

  /** Aktifkan/matikan mikrofon (mute); mengembalikan status mute yang baru. */
  const setMuted = (muted: boolean) => {
    mic?.getAudioTracks().forEach((track) => { track.enabled = !muted })
    return muted
  }

  /** Beri tahu lawan bicara bahwa panggilan ini direkam (atau berhenti direkam) di perangkat kita. */
  const announceRecording = (on: boolean) => {
    if (phase === 'connected') emit('record', { on })
  }

  return {
    start, accept, reject, hangup, handleSignal, setMuted, announceRecording,
    phase: () => phase,
    /** Suara mikrofon lokal; null bila panggilan belum/tidak aktif. */
    localStream: () => mic,
  }
}
