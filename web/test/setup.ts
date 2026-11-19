import * as h3 from 'h3'
import { transportKeys } from '../server/utils/transport'

const mockConfig = {
  public: {
    supabaseUrl: 'https://test.supabase.co',
    supabaseAnonKey: 'test-anon-key',
  },
  supabaseServiceRoleKey: 'test-service-key',
  transportPrivateKey: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
  gdriveClientId: 'test-gdrive-client',
  gdriveClientSecret: 'test-gdrive-secret',
  gdriveRefreshToken: 'test-gdrive-refresh',
}

export const createMockEvent = (headers: Record<string, string> = {}, url = 'https://example.com/api/test') => {
  const parsedUrl = new URL(url)
  const proto = parsedUrl.protocol.replace(':', '')
  const req: any = {
    headers: {
      host: parsedUrl.host,
      'x-forwarded-proto': proto,
      ...headers,
    },
    url: parsedUrl.pathname + parsedUrl.search,
    socket: { remoteAddress: '127.0.0.1', encrypted: proto === 'https' },
    connection: { remoteAddress: '127.0.0.1', encrypted: proto === 'https' },
    method: 'GET',
  }
  const headersMap = new Map<string, any>()
  const res: any = {
    setHeader: (k: string, v: any) => headersMap.set(k.toLowerCase(), v),
    getHeader: (k: string) => headersMap.get(k.toLowerCase()),
    removeHeader: (k: string) => headersMap.delete(k.toLowerCase()),
    hasHeader: (k: string) => headersMap.has(k.toLowerCase()),
    appendHeader: (k: string, v: any) => {
      const existing = headersMap.get(k.toLowerCase())
      if (!existing) headersMap.set(k.toLowerCase(), v)
      else if (Array.isArray(existing)) existing.push(v)
      else headersMap.set(k.toLowerCase(), [existing, v])
    },
  }
  return h3.createEvent(req, res)
}

Object.assign(globalThis, {
  createError: h3.createError,
  isError: h3.isError,
  getRequestHeader: h3.getRequestHeader,
  getRequestIP: h3.getRequestIP,
  getRequestURL: h3.getRequestURL,
  setResponseHeader: h3.setResponseHeader,
  getCookie: h3.getCookie,
  setCookie: h3.setCookie,
  deleteCookie: h3.deleteCookie,
  readRawBody: async (event: any, encoding?: string) => {
    if (event?._body !== undefined) return event._body
    return h3.readRawBody(event, encoding as any)
  },
  getRouterParam: h3.getRouterParam,
  defineEventHandler: h3.defineEventHandler,
  useRuntimeConfig: () => mockConfig,
  serviceClient: () => null,
  transportKeys,
  createMockEvent,
})
