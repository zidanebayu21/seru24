import { SecureFetchError, createSecureFetch } from '#shared/secure-fetch-core'

// POST terenkripsi ke /api/auth/* (doc/keamanan-password-transport.md); isi tidak terbaca di DevTools Network.
// Logika bersama di shared/secure-fetch-core.ts; di web cukup fetch relatif (browser mengirim Origin sendiri).

export const secureFetch = createSecureFetch({
  getJson: async (path) => {
    const res = await fetch(path)
    if (!res.ok) throw new SecureFetchError(res.status, null)
    return res.json()
  },
  postText: async (path, body) => {
    const res = await fetch(path, { method: 'POST', headers: { 'content-type': 'text/plain' }, body })
    return { status: res.status, text: await res.text() }
  },
})
