/**
 * Bantuan endpoint /api/files/*: autentikasi token, akses RPC seru24_file_* (service_role), dan pembacaan potongan.
 * Potongan berisi blob yang sudah terenkripsi E2EE di browser, jadi dikirim biner tanpa envelope transport.
 */
import type { H3Event } from 'h3'
import { FILE_CHUNK_BYTES, isUuid } from '#shared/file-core'

/** Pemilik token pada header Authorization: Bearer (endpoint biner tidak memakai cookie, jadi tidak rentan CSRF). */
export const bearerUser = (event: H3Event) => {
  const header = getRequestHeader(event, 'authorization') ?? ''
  return userFromToken(event, header.startsWith('Bearer ') ? header.slice('Bearer '.length) : '')
}

export const fileRpc = async <T>(event: H3Event, fn: string, args: Record<string, unknown>): Promise<T> => {
  const { data, error } = await requireServiceClient(event).rpc(fn, args)
  if (error) throw new Error(`${fn} gagal: ${error.message}`)
  return data as T
}

/** id lampiran dari parameter rute; 400 bila bukan UUID (OWASP ASVS V5.1.3). */
export const attachmentIdParam = (event: H3Event): string => {
  const id = getRouterParam(event, 'id')
  if (!isUuid(id)) throw createError({ statusCode: 400, statusMessage: 'Data tidak valid' })
  return id
}

/** Bilangan bulat >= 0 dari header/query; 400 bila tidak valid. */
export const nonNegativeInt = (value: unknown): number => {
  const n = Number(value)
  if (!Number.isSafeInteger(n) || n < 0) throw createError({ statusCode: 400, statusMessage: 'Data tidak valid' })
  return n
}

/** Body biner satu potongan; 413 bila melebihi FILE_CHUNK_BYTES. */
export const readChunk = async (event: H3Event): Promise<Uint8Array> => {
  const body = await readRawBody(event, false)
  if (!body || body.length === 0) throw createError({ statusCode: 400, statusMessage: 'Potongan kosong' })
  if (body.length > FILE_CHUNK_BYTES) throw createError({ statusCode: 413, statusMessage: 'Potongan terlalu besar' })
  return new Uint8Array(body)
}
