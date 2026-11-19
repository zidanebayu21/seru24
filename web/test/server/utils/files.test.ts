import { describe, expect, it } from 'vitest'
import { FILE_CHUNK_BYTES } from '#shared/file-core'
import {
  attachmentIdParam,
  nonNegativeInt,
  readChunk,
} from '../../../server/utils/files'
import { createMockEvent } from '../../setup'

describe('server files utils', () => {
  it('validasi parameter attachmentIdParam sebagai UUID', () => {
    const validUuid = '123e4567-e89b-12d3-a456-426614174000'
    const ev1 = createMockEvent()
    ;(ev1.context as any).params = { id: validUuid }
    ;(globalThis as any).getRouterParam = () => validUuid

    expect(attachmentIdParam(ev1)).toBe(validUuid)

    ;(globalThis as any).getRouterParam = () => 'not-a-uuid'
    expect(() => attachmentIdParam(ev1)).toThrow()
  })

  it('validasi bilangan bulat non negatif (nonNegativeInt)', () => {
    expect(nonNegativeInt(0)).toBe(0)
    expect(nonNegativeInt('42')).toBe(42)
    expect(() => nonNegativeInt(-1)).toThrow()
    expect(() => nonNegativeInt('abc')).toThrow()
    expect(() => nonNegativeInt(1.5)).toThrow()
  })

  it('membaca potongan chunk biner dan memeriksa ukuran (readChunk)', async () => {
    const ev = createMockEvent()

    ;(globalThis as any).readRawBody = async () => null
    await expect(readChunk(ev)).rejects.toThrow()

    const validBytes = Buffer.from(new Uint8Array(1024))
    ;(globalThis as any).readRawBody = async () => validBytes
    const chunk = await readChunk(ev)
    expect(chunk).toHaveLength(1024)

    const oversizedBytes = Buffer.alloc(FILE_CHUNK_BYTES + 1)
    ;(globalThis as any).readRawBody = async () => oversizedBytes
    await expect(readChunk(ev)).rejects.toThrow()
  })
})
