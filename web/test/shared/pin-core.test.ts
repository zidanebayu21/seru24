import { describe, expect, it } from 'vitest'
import { MAX_PINS, addPin, canPin, parsePins, pinsNewestFirst, pinsStorageKey, prunePins, removePin } from '../../shared/pin-core'

const fill = (count: number) => Array.from({ length: count }, (_, i) => `m${i}`)

describe('parsePins', () => {
  it('membaca daftar yang sah dan membuang duplikat', () => {
    expect(parsePins('["a","b","a"]')).toEqual(['a', 'b'])
  })

  it('mengabaikan data kosong, rusak, atau bukan daftar', () => {
    expect(parsePins(null)).toEqual([])
    expect(parsePins('{oops')).toEqual([])
    expect(parsePins('{"a":1}')).toEqual([])
    expect(parsePins('[1,"",null,"ok"]')).toEqual(['ok'])
  })

  it('membatasi sampai MAX_PINS pin terbaru', () => {
    expect(parsePins(JSON.stringify(fill(15)))).toEqual(fill(15).slice(-MAX_PINS))
  })
})

describe('addPin dan removePin', () => {
  it('menambah pin baru di akhir dan tidak menggandakan', () => {
    expect(addPin(['a'], 'b')).toEqual(['a', 'b'])
    expect(addPin(['a', 'b'], 'a')).toEqual(['a', 'b'])
  })

  it('menolak pin ke-11 dan canPin menjadi false', () => {
    const full = fill(MAX_PINS)
    expect(canPin(full)).toBe(false)
    expect(addPin(full, 'baru')).toEqual(full)
  })

  it('bisa menyematkan lagi setelah satu dilepas', () => {
    const afterRemove = removePin(fill(MAX_PINS), 'm3')
    expect(canPin(afterRemove)).toBe(true)
    expect(addPin(afterRemove, 'baru')).toHaveLength(MAX_PINS)
  })
})

describe('prunePins', () => {
  it('membuang pin yang pesannya sudah tidak ada', () => {
    expect(prunePins(['a', 'b', 'c'], new Set(['a', 'c']))).toEqual(['a', 'c'])
  })
})

describe('urutan dan kunci', () => {
  it('pin terakhir tampil paling atas tanpa mengubah daftar asli', () => {
    const pins = ['a', 'b', 'c']
    expect(pinsNewestFirst(pins)).toEqual(['c', 'b', 'a'])
    expect(pins).toEqual(['a', 'b', 'c'])
  })

  it('kunci penyimpanan dipisah per akun dan percakapan', () => {
    expect(pinsStorageKey('u1', 'c1')).not.toBe(pinsStorageKey('u2', 'c1'))
    expect(pinsStorageKey('u1', 'c1')).not.toBe(pinsStorageKey('u1', 'c2'))
  })
})
