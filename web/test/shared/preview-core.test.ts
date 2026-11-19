import { describe, expect, it } from 'vitest'
import { DELETED_PREVIEW, PREVIEW_MAX, deletedPreview, isFreshPreview, previewText } from '../../shared/preview-core'

describe('previewText', () => {
  it('menjadikan satu baris dan memberi awalan untuk pesan sendiri', () => {
    expect(previewText('halo\n\n  apa   kabar', false)).toBe('halo apa kabar')
    expect(previewText('siap', true)).toBe('Anda: siap')
  })

  it('memotong pesan panjang dengan elipsis', () => {
    const result = previewText('a'.repeat(300), false)
    expect(result).toHaveLength(PREVIEW_MAX)
    expect(result.endsWith('…')).toBe(true)
  })

  it('teks kosong tetap kosong agar tampilan memakai cadangan', () => {
    expect(previewText('   \n ', true)).toBe('')
  })
})

describe('isFreshPreview', () => {
  const preview = { text: 'x', mine: false, at: '2026-11-19T06:00:00.000Z' }
  it('segar bila sama atau lebih baru dari pesan terakhir percakapan', () => {
    expect(isFreshPreview(preview, '2026-11-19T06:00:00.000Z')).toBe(true)
    expect(isFreshPreview(preview, '2026-11-19T05:59:00.000Z')).toBe(true)
  })
  it('basi bila ada pesan lebih baru, atau data belum ada', () => {
    expect(isFreshPreview(preview, '2026-11-19T06:00:01.000Z')).toBe(false)
    expect(isFreshPreview(undefined, '2026-11-19T06:00:00.000Z')).toBe(false)
    expect(isFreshPreview(preview, null)).toBe(false)
  })
})

describe('deletedPreview', () => {
  it('menandai pesan terakhir yang dihapus', () => {
    expect(deletedPreview('2026-11-19T06:00:00.000Z')).toEqual({ text: DELETED_PREVIEW, mine: false, at: '2026-11-19T06:00:00.000Z' })
  })
})
