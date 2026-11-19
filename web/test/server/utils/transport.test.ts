import { describe, expect, it } from 'vitest'
import { sealRequest } from '#shared/transport'
import {
  readSecureBody,
  secureResponse,
  transportKeys,
} from '../../../server/utils/transport'
import { createMockEvent } from '../../setup'

describe('server transport utils', () => {
  it('mengambil kunci transport dari konfigurasi server', () => {
    const event = createMockEvent()
    const keys = transportKeys(event)
    expect(keys.secretKey).toBeDefined()
    expect(keys.publicKey).toBeDefined()
    expect(keys.keyId).toBeDefined()
  })

  it('membuka request terenkripsi dan menyusun respons terenkripsi', async () => {
    const event = createMockEvent({ 'content-type': 'text/plain' })
    const { publicKey, keyId } = transportKeys(event)

    const payload = { hello: 'world', count: 42 }
    const { compact } = sealRequest(publicKey, keyId, payload)

    ;(event as any)._body = compact
    ;(globalThis as any).readRawBody = async () => compact

    const opened = await readSecureBody(event)
    expect(opened).toEqual(payload)
    expect(event.context.secure).toBeDefined()

    const responsePayload = { status: 'success' }
    const sealedRes = secureResponse(event, responsePayload)
    expect(typeof sealedRes).toBe('string')
    expect(sealedRes.length).toBeGreaterThan(20)
  })

  it('menolak body yang kosong atau tidak valid', async () => {
    const event = createMockEvent()
    ;(globalThis as any).readRawBody = async () => ''
    await expect(readSecureBody(event)).rejects.toThrow()
  })
})
