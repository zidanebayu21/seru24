import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import {
  deleteDriveFile,
  downloadRange,
  driveConfig,
  driveQuota,
  findApkRelease,
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

  it('membedakan pencarian rilis APK react dan rust di Drive', async () => {
    const config = { clientId: 'c', clientSecret: 's', refreshToken: 'r' }
    const fakeId = '1AbCdEfGhIjKlMnOp_qrs-TUV'
    const sha = 'a'.repeat(64)
    const calls: string[] = []
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      calls.push(url)
      if (url.includes('oauth2.googleapis.com')) {
        return { ok: true, json: async () => ({ access_token: 'tok-apk', expires_in: 3600 }) } as any
      }
      const isRust = decodeURIComponent(url).includes('android_rust_apk')
      return {
        ok: true,
        json: async () => ({
          files: [{
            id: fakeId,
            size: isRust ? '16340999' : '16898781',
            modifiedTime: '2026-11-20T09:00:00.000Z',
            appProperties: {
              seru24_kind: isRust ? 'android_rust_apk' : 'android_apk',
              version_code: isRust ? '2' : '25',
              version_name: isRust ? '0.1.2' : '1.25',
              sha256: sha,
            },
          }],
        }),
      } as any
    })

    const rustRel = await findApkRelease(config, 'rust')
    expect(rustRel?.variant).toBe('rust')
    expect(rustRel?.versionCode).toBe(2)

    const reactRel = await findApkRelease(config)
    expect(reactRel?.variant).toBeUndefined()
    expect(reactRel?.versionCode).toBe(25)

    const searchUrls = calls.filter((u) => u.includes('/drive/v3/files'))
    expect(decodeURIComponent(searchUrls[0] ?? '')).toContain('android_rust_apk')
    expect(decodeURIComponent(searchUrls[1] ?? '')).toContain('android_apk')
  })
})
