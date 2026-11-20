import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  CALL_RING_TIMEOUT_MS,
  createCallController,
  type CallEndReason,
  type CallPhase,
  type CallSignal,
  type MicStream,
  type PeerLike,
} from '../../shared/call-core'

class FakePeer {
  connectionState = 'new'
  signalingState = 'stable'
  remoteDescription: unknown = null
  added: unknown[] = []
  closed = false
  onicecandidate: ((e: { candidate: { toJSON: () => object } | null }) => void) | null = null
  ontrack: ((e: { streams: unknown[] }) => void) | null = null
  onconnectionstatechange: (() => void) | null = null
  addTrack = vi.fn()
  addIceCandidate = vi.fn(async (c: unknown) => { this.added.push(c) })
  createOffer = vi.fn(async () => ({ type: 'offer', sdp: 'offer-sdp' }))
  createAnswer = vi.fn(async () => ({ type: 'answer', sdp: 'answer-sdp' }))
  setLocalDescription = vi.fn(async (d: { type: string }) => {
    this.signalingState = d.type === 'offer' ? 'have-local-offer' : 'stable'
  })
  setRemoteDescription = vi.fn(async (d: unknown) => {
    this.remoteDescription = d
    this.signalingState = 'stable'
  })
  close = vi.fn(() => { this.closed = true })
  connect(state: string) {
    this.connectionState = state
    this.onconnectionstatechange?.()
  }
}

const fakeMic = () => {
  const track = { stop: vi.fn(), enabled: true }
  return { track, stream: { getTracks: () => [track], getAudioTracks: () => [track] } as unknown as MicStream }
}

const makeSide = (myId: string, getMic?: () => Promise<MicStream>) => {
  const peers: FakePeer[] = []
  const log = { phases: [] as CallPhase[], ends: [] as CallEndReason[], sent: [] as CallSignal[], remote: [] as unknown[] }
  const mic = fakeMic()
  let other: ReturnType<typeof createCallController> | null = null
  const ctl = createCallController({
    myId,
    send: (s) => { log.sent.push(s); void other?.handleSignal(s) },
    onPhase: (p) => log.phases.push(p),
    onRemoteStream: (s) => log.remote.push(s),
    onEnd: (r) => log.ends.push(r),
    newCallId: () => 'call-1',
    getMic: getMic ?? (async () => mic.stream),
    createPeer: () => { const p = new FakePeer(); peers.push(p); return p as unknown as PeerLike },
  })
  return { ctl, peers, log, mic, link: (o: ReturnType<typeof createCallController>) => { other = o } }
}

const pair = () => {
  const a = makeSide('alice')
  const b = makeSide('bob')
  a.link(b.ctl)
  b.link(a.ctl)
  return { a, b }
}
const flush = () => new Promise((r) => setTimeout(r, 0))

afterEach(() => vi.useRealTimers())

describe('call-core', () => {
  it('menyambungkan panggilan: invite → accept → offer/answer → connected', async () => {
    const { a, b } = pair()
    await a.ctl.start()
    expect(a.ctl.phase()).toBe('calling')
    expect(b.ctl.phase()).toBe('incoming')

    await b.ctl.accept()
    await flush()
    expect(a.log.sent.map((s) => s.type)).toEqual(['invite', 'offer'])
    expect(b.log.sent.map((s) => s.type)).toEqual(['accept', 'answer'])
    expect(a.peers[0].setRemoteDescription).toHaveBeenCalledWith({ type: 'answer', sdp: 'answer-sdp' })
    expect(b.peers[0].setRemoteDescription).toHaveBeenCalledWith({ type: 'offer', sdp: 'offer-sdp' })

    a.peers[0].connect('connected')
    b.peers[0].connect('connected')
    expect(a.ctl.phase()).toBe('connected')
    expect(b.ctl.phase()).toBe('connected')
  })

  it('hangup menutup kedua sisi dan mematikan mikrofon', async () => {
    const { a, b } = pair()
    await a.ctl.start()
    await b.ctl.accept()
    await flush()
    a.ctl.hangup()
    expect(a.ctl.phase()).toBe('idle')
    expect(b.ctl.phase()).toBe('idle')
    expect(a.mic.track.stop).toHaveBeenCalled()
    expect(b.mic.track.stop).toHaveBeenCalled()
    expect(a.peers[0].closed).toBe(true)
    expect(a.log.ends).toEqual(['hangup'])
    expect(b.log.ends).toEqual(['hangup'])
  })

  it('penerima menolak panggilan', async () => {
    const { a, b } = pair()
    await a.ctl.start()
    b.ctl.reject()
    expect(a.log.ends).toEqual(['rejected'])
    expect(b.log.ends).toEqual(['rejected'])
    expect(a.ctl.phase()).toBe('idle')
  })

  it('membalas busy bila sedang dalam panggilan lain', async () => {
    const { a, b } = pair()
    await b.ctl.start()
    await a.ctl.handleSignal({ type: 'invite', callId: 'other', from: 'carol' })
    expect(a.log.sent.at(-1)).toMatchObject({ type: 'busy', callId: 'other' })
    expect(a.ctl.phase()).toBe('incoming')
  })

  it('panggilan tidak dijawab berakhir timeout', async () => {
    vi.useFakeTimers()
    const { a, b } = pair()
    await a.ctl.start()
    vi.advanceTimersByTime(CALL_RING_TIMEOUT_MS)
    expect(a.log.ends).toEqual(['timeout'])
    expect(b.log.ends).toEqual(['timeout'])
  })

  it('izin mikrofon ditolak membatalkan panggilan tanpa mengirim invite', async () => {
    const a = makeSide('alice', async () => { throw new Error('denied') })
    await a.ctl.start()
    expect(a.log.ends).toEqual(['mic-denied'])
    expect(a.log.sent).toEqual([])
  })

  it('menahan kandidat ICE sampai remote description terpasang', async () => {
    const b = makeSide('bob')
    await b.ctl.handleSignal({ type: 'invite', callId: 'call-1', from: 'alice' })
    await b.ctl.accept()
    await b.ctl.handleSignal({ type: 'ice', callId: 'call-1', from: 'alice', candidate: { candidate: 'c1' } })
    expect(b.peers).toHaveLength(0)
    await b.ctl.handleSignal({ type: 'offer', callId: 'call-1', from: 'alice', sdp: 'offer-sdp' })
    expect(b.peers[0].added).toEqual([{ candidate: 'c1' }])
  })

  it('mengabaikan sinyal sendiri dan panggilan dengan callId lain', async () => {
    const b = makeSide('bob')
    await b.ctl.handleSignal({ type: 'invite', callId: 'call-1', from: 'bob' })
    expect(b.ctl.phase()).toBe('idle')
    await b.ctl.handleSignal({ type: 'invite', callId: 'call-1', from: 'alice' })
    await b.ctl.handleSignal({ type: 'hangup', callId: 'lain', from: 'alice' })
    expect(b.ctl.phase()).toBe('incoming')
  })

  it('koneksi failed mengakhiri panggilan dan mute mematikan track', async () => {
    const { a, b } = pair()
    await a.ctl.start()
    await b.ctl.accept()
    await flush()
    expect(a.ctl.setMuted(true)).toBe(true)
    expect(a.mic.track.enabled).toBe(false)
    a.peers[0].connect('failed')
    expect(a.log.ends).toEqual(['failed'])
    expect(b.log.ends).toEqual(['hangup'])
  })
})

describe('call-core: rekaman', () => {
  it('memberi tahu lawan bicara saat merekam dan hanya saat tersambung', async () => {
    const onPeerRecording = vi.fn()
    const a = makeSide('alice')
    const bPeers: FakePeer[] = []
    const b = createCallController({
      myId: 'bob',
      send: (s) => void a.ctl.handleSignal(s),
      onPhase: () => undefined,
      onRemoteStream: () => undefined,
      onEnd: () => undefined,
      onPeerRecording,
      newCallId: () => 'call-1',
      getMic: async () => fakeMic().stream,
      createPeer: () => { const p = new FakePeer(); bPeers.push(p); return p as unknown as PeerLike },
    })
    a.link(b)
    await a.ctl.start()
    a.ctl.announceRecording(true)
    expect(onPeerRecording).not.toHaveBeenCalled()
    await b.accept()
    await flush()
    a.peers[0].connect('connected')
    bPeers[0].connect('connected')
    a.ctl.announceRecording(true)
    expect(onPeerRecording).toHaveBeenLastCalledWith(true)
    a.ctl.announceRecording(false)
    expect(onPeerRecording).toHaveBeenLastCalledWith(false)
    expect(a.ctl.localStream()).not.toBeNull()
    a.ctl.hangup()
    expect(a.ctl.localStream()).toBeNull()
  })
})

describe('call-core: kualitas suara', () => {
  it('menetapkan maxBitrate pengirim sesuai pilihan saat peer dibuat dan saat tersambung', async () => {
    const setParameters = vi.fn(async () => undefined)
    const sender = { getParameters: () => ({}) as { encodings?: { maxBitrate?: number }[] }, setParameters }
    const peers: FakePeer[] = []
    const ctl = createCallController({
      myId: 'alice',
      send: () => undefined,
      onPhase: () => undefined,
      onRemoteStream: () => undefined,
      onEnd: () => undefined,
      newCallId: () => 'call-1',
      getBitrate: () => 128_000,
      getMic: async () => fakeMic().stream,
      createPeer: () => {
        const p = Object.assign(new FakePeer(), { getSenders: () => [sender] })
        peers.push(p)
        return p as unknown as PeerLike
      },
    })
    await ctl.start()
    await ctl.handleSignal({ type: 'accept', callId: 'call-1', from: 'bob' })
    expect(setParameters).toHaveBeenCalledWith({ encodings: [{ maxBitrate: 128_000 }] })
    setParameters.mockClear()
    peers[0].connect('connected')
    await flush()
    expect(setParameters).toHaveBeenCalledTimes(1)
  })

  it('tanpa getBitrate tidak menyentuh parameter pengirim', async () => {
    const { a, b } = pair()
    await a.ctl.start()
    await b.ctl.accept()
    await flush()
    expect(a.peers[0].setParameters).toBeUndefined()
  })
})
