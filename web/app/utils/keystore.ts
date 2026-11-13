import { fromBase64, toBase64, type SecretKeyring } from '#shared/crypto'

// Kunci privat di IndexedDB, dibungkus kunci AES-GCM WebCrypto yang non-extractable:
// skrip lain tidak bisa mengekspor kunci pembungkus, hanya memakainya di origin ini (OWASP ASVS V6.4).

const DB_NAME = 'seru24'
const STORE = 'keyring'

interface StoredKeyring {
  wrapKey: CryptoKey
  iv: Uint8Array
  data: ArrayBuffer
}

const openDb = () =>
  new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1)
    request.onupgradeneeded = () => request.result.createObjectStore(STORE)
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })

const withStore = async <T>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest<T>) => {
  const db = await openDb()
  try {
    return await new Promise<T>((resolve, reject) => {
      const request = run(db.transaction(STORE, mode).objectStore(STORE))
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
  } finally {
    db.close()
  }
}

export const saveKeyring = async (userId: string, keyring: SecretKeyring) => {
  const wrapKey = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'])
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const plain = new TextEncoder().encode(
    JSON.stringify(Object.fromEntries(Object.entries(keyring).map(([v, k]) => [v, toBase64(k)]))),
  )
  const data = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, wrapKey, plain)
  plain.fill(0)
  await withStore('readwrite', (store) => store.put({ wrapKey, iv, data } satisfies StoredKeyring, userId))
}

export const loadKeyring = async (userId: string): Promise<SecretKeyring | null> => {
  const stored = await withStore<StoredKeyring | undefined>('readonly', (store) => store.get(userId))
  if (!stored) return null
  try {
    const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: stored.iv }, stored.wrapKey, stored.data)
    const parsed = JSON.parse(new TextDecoder().decode(plain)) as Record<string, string>
    return Object.fromEntries(Object.entries(parsed).map(([v, k]) => [v, fromBase64(k)]))
  } catch {
    return null
  }
}

export const deleteKeyring = (userId: string) => withStore('readwrite', (store) => store.delete(userId))
