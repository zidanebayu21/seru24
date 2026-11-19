import { describe, expect, it } from 'vitest'
import {
  FILE_CHUNK_BYTES,
  MAX_FILE_BYTES,
  createTransferMeter,
  formatDuration,
  splitByFileLimit,
  chunkRanges,
  formatFileSize,
  parseFileBody,
  safeFileName,
} from './file-core'

const body = {
  id: '67e76b16-020b-491b-a492-a5b9db754870',
  name: 'laporan.pdf',
  mime: 'application/pdf',
  size: 1234,
  key: 'A'.repeat(43) + '=',
  iv: 'B'.repeat(16),
}

describe('file-core', () => {
  it('potongan 3 MiB adalah kelipatan 256 KiB (syarat upload resumable Drive)', () => {
    expect(FILE_CHUNK_BYTES % (256 * 1024)).toBe(0)
    expect(FILE_CHUNK_BYTES).toBeLessThan(4_500_000)
  })

  it('membagi blob menjadi rentang potongan', () => {
    expect(chunkRanges(0)).toEqual([])
    expect(chunkRanges(10, 4)).toEqual([[0, 4], [4, 8], [8, 10]])
    const ranges = chunkRanges(MAX_FILE_BYTES + 16)
    expect(ranges).toHaveLength(17)
    expect(ranges.at(-1)).toEqual([16 * FILE_CHUNK_BYTES, MAX_FILE_BYTES + 16])
  })

  it('membersihkan nama file dari path dan karakter kontrol', () => {
    expect(safeFileName('C:\\Users\\x\\rahasia.docx')).toBe('rahasia.docx')
    expect(safeFileName('../../etc/passwd')).toBe('passwd')
    expect(safeFileName('a\u0000b\nc.txt')).toBe('abc.txt')
    expect(safeFileName('   ')).toBe('dokumen')
    expect(safeFileName('x'.repeat(500))).toHaveLength(200)
  })

  it('memvalidasi isi pesan file', () => {
    expect(parseFileBody(body)).toEqual(body)
    expect(parseFileBody({ ...body, id: 'bukan-uuid' })).toBeNull()
    expect(parseFileBody({ ...body, size: MAX_FILE_BYTES + 1 })).toBeNull()
    expect(parseFileBody({ ...body, key: 'pendek' })).toBeNull()
    expect(parseFileBody(null)).toBeNull()
  })

  it('memformat ukuran file', () => {
    expect(formatFileSize(512)).toBe('512 B')
    expect(formatFileSize(2048)).toBe('2.0 KB')
    expect(formatFileSize(50 * 1024 * 1024)).toBe('50.0 MB')
  })
})

describe('transfer meter dan batas file', () => {
  it('menghitung persen, kecepatan, dan sisa waktu dari byte yang bergerak', () => {
    let t = 0
    const meter = createTransferMeter('Mengunggah', () => t)
    expect(meter(0, 5 * 1024 * 1024).label).toBe('Mengunggah 0%')
    t = 1000
    const status = meter(1024 * 1024, 5 * 1024 * 1024)
    expect(status.fraction).toBeCloseTo(0.2)
    expect(status.label).toBe('Mengunggah 20% · 1.0 MB/dtk · sisa 4 dtk')
  })

  it('formatDuration memakai dtk, mnt, dan j', () => {
    expect(formatDuration(0.2)).toBe('1 dtk')
    expect(formatDuration(65)).toBe('1 mnt 5 dtk')
    expect(formatDuration(3720)).toBe('1 j 2 mnt')
  })

  it('splitByFileLimit menahan file di atas 50 MB dan menyusun pesan popup', () => {
    const small = { name: 'a.png', size: 1024 }
    const big = { name: 'film.mp4', size: MAX_FILE_BYTES + 1 }
    expect(splitByFileLimit([small])).toEqual({ allowed: [small], message: null })
    const result = splitByFileLimit([small, big])
    expect(result.allowed).toEqual([small])
    expect(result.message).toContain('film.mp4')
  })
})
