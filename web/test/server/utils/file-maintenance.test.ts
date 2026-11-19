import { describe, expect, it, vi } from 'vitest'
import { runFileMaintenance } from '../../../server/utils/file-maintenance'
import { createMockEvent } from '../../setup'

describe('server file-maintenance utils', () => {
  it('menjalankan runFileMaintenance mode dryRun dan rekap hasil', async () => {
    const event = createMockEvent()

    ;(globalThis as any).fileRpc = vi.fn(async (_event: any, fn: string) => {
      if (fn === 'seru24_file_cleanup_candidates') {
        return [
          { id: 'f-1', drive_file_id: 'd-1' },
          { id: 'f-2', drive_file_id: null },
        ]
      }
      if (fn === 'seru24_file_usage') {
        return { files: 10, bytes: 50_000_000 }
      }
      return null
    })

    const dryRes = await runFileMaintenance(event, true)
    expect(dryRes.files).toBe(10)
    expect(dryRes.bytes).toBe(50_000_000)
    expect(dryRes.cleaned).toBe(2)
  })
})
