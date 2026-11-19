import { describe, expect, it, vi } from 'vitest'
import {
  defineLoggedHandler,
  logAuthEvent,
  logAuthSuccess,
} from '../../../server/utils/logger'
import { createMockEvent } from '../../setup'

describe('server logger utils', () => {
  it('mencatat event autentikasi (logAuthEvent, logAuthSuccess)', () => {
    const event = createMockEvent()
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    logAuthEvent(event, 'info', 'login_attempt', 'Mencoba login', 200, 'u-1')
    expect(warnSpy).toHaveBeenCalled()

    logAuthSuccess(event, 'login_success', 'u-1', 'Login berhasil')
    expect(warnSpy).toHaveBeenCalledTimes(2)

    warnSpy.mockRestore()
  })

  it('membungkus event handler dengan defineLoggedHandler', async () => {
    const ev = createMockEvent()

    const okHandler = defineLoggedHandler(async () => ({ result: 'ok' }), { rateLimited: false })
    const res = await okHandler(ev)
    expect(res).toEqual({ result: 'ok' })

    const fail400 = defineLoggedHandler(async () => {
      throw (globalThis as any).createError({ statusCode: 400, statusMessage: 'Bad input' })
    }, { rateLimited: false })

    await expect(fail400(ev)).rejects.toThrow()

    const fail500 = defineLoggedHandler(async () => {
      throw new Error('Database crash')
    }, { rateLimited: false })

    await expect(fail500(ev)).rejects.toThrow()
  })
})
