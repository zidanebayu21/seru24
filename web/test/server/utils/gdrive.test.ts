import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import {
  deleteDriveFile,
  downloadRange,
  driveConfig,
  driveQuota,
  receivedFromRange,
  uploadChunk,
} from '../../../server/utils/gdrive'
import { createMockEvent } from '../../setup'

describe('server gdrive utils', () => {
  const originalFetch = globalThis.fetch

  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  it('menghitung byte dari header Range Drive', () => {
    expect(receivedFromRange('bytes=0-1023')).toBe(1024)
    expect(receivedFromRange(null)).toBe(0)
    expect(receivedFromRange('')).toBe(0)
    expect(receivedFromRange('invalid')).toBe(0)
  })

  it('membaca konfigurasi drive dari runtime config', () => {
    const event = createMockEvent()
    const cfg = driveConfig(event)
    expect(cfg.clientId).toBe('test-gdrive-client')
    expect(cfg.clientSecret).toBe('test-gdrive-secret')
    expect(cfg.refreshToken).toBe('test-gdrive-refresh')
  })

  it('mengunggah potongan (uploadChunk)', async () => {
    globalThis.fetch = vi.fn().mockResolvedValueOnce({
      status: 308,
      ok: false,
      headers: new Headers({ range: 'bytes=0-511' }),
    } as any)

    const chunk1 = await uploadChunk('https://upload.session/1', new Uint8Array(512), 0, 1024)
    expect(chunk1).toEqual({ done: false, received: 512 })

    globalThis.fetch = vi.fn().mockResolvedValueOnce({
      status: 200,
      ok: true,
      json: async () => ({ id: 'file-uploaded-id' }),
    } as any)

    const chunk2 = await uploadChunk('https://upload.session/1', new Uint8Array(512), 512, 1024)
    expect(chunk2).toEqual({ done: true, fileId: 'file-uploaded-id' })
  })

  it('mengambil kuota, mengunduh rentang byte, dan menghapus file', async () => {
    const config = {
      clientId: 'c',
      clientSecret: 's',
      refreshToken: 'r',
    }

    globalThis.fetch = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ access_token: 'fake-oauth-tok', expires_in: 3600 }),
      } as any)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ storageQuota: { usage: '1000', limit: '5000' } }),
      } as any)

    const quota = await driveQuota(config)
    expect(quota).toEqual({ usage: 1000, limit: 5000 })

    const mockData = new Uint8Array([1, 2, 3, 4])
    globalThis.fetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      arrayBuffer: async () => mockData.buffer,
    } as any)

    const downloaded = await downloadRange(config, 'file-123', 0, 3)
    expect(downloaded).toEqual(mockData)

    globalThis.fetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      status: 204,
    } as any)

    await expect(deleteDriveFile(config, 'file-123')).resolves.toBeUndefined()
  })
})
