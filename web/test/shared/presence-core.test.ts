import { describe, expect, it, vi } from 'vitest'
import { createConversationPresence, TYPING_SEND_INTERVAL_MS } from '../../shared/presence-core'
import type { SupabaseClient } from '@supabase/supabase-js'

describe('presence-core', () => {
  it('mengelola presence online dan status mengetik lawan bicara', () => {
    vi.useFakeTimers()
    const presenceCallbacks: Record<string, any> = {}
    const broadcastCallbacks: Record<string, any> = {}

    const mockChannel = {
      on: vi.fn((type: string, filter: any, cb: any) => {
        if (type === 'presence') presenceCallbacks[filter.event] = cb
        if (type === 'broadcast') broadcastCallbacks[filter.event] = cb
        return mockChannel
      }),
      subscribe: vi.fn((cb: (status: string) => void) => {
        cb('SUBSCRIBED')
        return mockChannel
      }),
      track: vi.fn(async () => 'ok'),
      send: vi.fn(async () => 'ok'),
      presenceState: vi.fn(() => ({ 'user-me': [{}], 'user-peer': [{}] })),
    }

    const mockClient = {
      channel: vi.fn(() => mockChannel),
      removeChannel: vi.fn(async () => 'ok'),
    } as unknown as SupabaseClient

    let currentPresence = { online: false, typing: false }
    const presence = createConversationPresence(mockClient, 'conv-1', 'user-me', (state) => {
      currentPresence = state
    })

    expect(mockChannel.subscribe).toHaveBeenCalled()
    expect(mockChannel.track).toHaveBeenCalled()

    presenceCallbacks.sync?.()
    expect(currentPresence.online).toBe(true)

    broadcastCallbacks.typing?.({ payload: { user_id: 'user-peer' } })
    expect(currentPresence.typing).toBe(true)

    presence.notifyTyping()
    expect(mockChannel.send).toHaveBeenCalled()

    mockChannel.send.mockClear()
    presence.notifyTyping()
    expect(mockChannel.send).not.toHaveBeenCalled()

    vi.advanceTimersByTime(TYPING_SEND_INTERVAL_MS + 10)
    presence.notifyTyping()
    expect(mockChannel.send).toHaveBeenCalled()

    presence.clearPeerTyping()
    expect(currentPresence.typing).toBe(false)

    presence.close()
    expect(mockClient.removeChannel).toHaveBeenCalledWith(mockChannel)

    vi.useRealTimers()
  })
})
