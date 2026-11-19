import { describe, expect, it, vi } from 'vitest'
import { createInbox } from '../../shared/inbox-core'
import type { SupabaseClient } from '@supabase/supabase-js'

describe('inbox-core', () => {
  it('berlangganan channel realtime dan memicu handler saat broadcast masuk', () => {
    const broadcastCallbacks: Record<string, (arg: { payload: Record<string, unknown> }) => void> = {}
    const mockChannel = {
      on: vi.fn((_type: string, filter: { event: string }, cb: any) => {
        broadcastCallbacks[filter.event] = cb
        return mockChannel
      }),
      subscribe: vi.fn(),
    }
    const mockClient = {
      channel: vi.fn(() => mockChannel),
      removeChannel: vi.fn(() => Promise.resolve('ok')),
    } as unknown as SupabaseClient

    let currentUserId: string | undefined = undefined
    const inbox = createInbox(() => mockClient, () => currentUserId)

    const received: string[] = []
    const unsub = inbox.onInbox((event, payload) => {
      received.push(`${event}:${payload.msg}`)
    })

    expect(mockClient.channel).not.toHaveBeenCalled()

    currentUserId = 'user-123'
    const unsub2 = inbox.onInbox(() => {})

    expect(mockClient.channel).toHaveBeenCalledWith('user:user-123', { config: { private: true } })
    expect(mockChannel.subscribe).toHaveBeenCalled()

    broadcastCallbacks.message_new?.({ payload: { msg: 'halo' } })
    expect(received).toEqual(['message_new:halo'])

    unsub()
    unsub2()
    inbox.closeInbox()
    expect(mockClient.removeChannel).toHaveBeenCalledWith(mockChannel)
  })

  it('closeInbox tidak error bila channel belum pernah dibuka', () => {
    const mockClient = {
      removeChannel: vi.fn(() => Promise.resolve('ok')),
    } as unknown as SupabaseClient
    const inbox = createInbox(() => mockClient, () => undefined)
    expect(() => inbox.closeInbox()).not.toThrow()
  })
})
