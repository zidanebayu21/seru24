import { peerLabel, type Conversation } from '#shared/chat-core'
import type { ChatMessage } from '#shared/e2ee-core'

const CHAT_DB_NAME = 'seru24_chat_cache'
const CHAT_DB_VERSION = 1
const KEYRING_DB_NAME = 'seru24'
const KEYRING_STORE = 'keyring'
const VISITOR_KEY_STORAGE = 'seru24:visitor-key'

const STORES = {
  wrapKeys: 'wrap_keys',
  conversations: 'conversations',
  messages: 'messages',
  deletedMsgs: 'deleted_msgs',
  clearedConv: 'cleared_conv',
} as const

interface EncryptedRecord {
  cacheKey: string
  userId: string
  conversationId?: string
  seq?: number
  iv: Uint8Array
  data: ArrayBuffer
  updatedAt: number
}

interface DeletedMsgRecord {
  cacheKey: string
  userId: string
  conversationId: string
  clientMsgId: string
  seq: number
  deletedAt: number
}

interface ClearedConvRecord {
  cacheKey: string
  userId: string
  conversationId: string
  clearedUpToSeq: number
  clearedAt: number
}

export interface LocalConversationUsage {
  conversationId: string
  label: string
  messages: number
  bytes: number
  maxSeq: number
}

export interface LocalChatStorageStats {
  conversations: number
  messages: number
  usageBytes: number | null
  quotaBytes: number | null
}

const activeDbs = new Set<IDBDatabase>()

const isSupported = () => typeof indexedDB !== 'undefined' && typeof crypto !== 'undefined' && Boolean(crypto.subtle)

const openChatDb = (): Promise<IDBDatabase> =>
  new Promise((resolve, reject) => {
    const request = indexedDB.open(CHAT_DB_NAME, CHAT_DB_VERSION)
    request.onupgradeneeded = () => {
      const db = request.result
      if (!db.objectStoreNames.contains(STORES.wrapKeys)) {
        db.createObjectStore(STORES.wrapKeys)
      }
      if (!db.objectStoreNames.contains(STORES.conversations)) {
        const convStore = db.createObjectStore(STORES.conversations, { keyPath: 'cacheKey' })
        convStore.createIndex('by_user', 'userId', { unique: false })
      }
      if (!db.objectStoreNames.contains(STORES.messages)) {
        const msgStore = db.createObjectStore(STORES.messages, { keyPath: 'cacheKey' })
        msgStore.createIndex('by_user', 'userId', { unique: false })
        msgStore.createIndex('by_conv', ['userId', 'conversationId'], { unique: false })
      }
      if (!db.objectStoreNames.contains(STORES.deletedMsgs)) {
        const delStore = db.createObjectStore(STORES.deletedMsgs, { keyPath: 'cacheKey' })
        delStore.createIndex('by_user', 'userId', { unique: false })
        delStore.createIndex('by_conv', ['userId', 'conversationId'], { unique: false })
      }
      if (!db.objectStoreNames.contains(STORES.clearedConv)) {
        const clrStore = db.createObjectStore(STORES.clearedConv, { keyPath: 'cacheKey' })
        clrStore.createIndex('by_user', 'userId', { unique: false })
      }
    }
    request.onsuccess = () => {
      const db = request.result
      activeDbs.add(db)
      db.onversionchange = () => {
        db.close()
        activeDbs.delete(db)
      }
      resolve(db)
    }
    request.onerror = () => reject(request.error)
  })

const withDb = async <T>(run: (db: IDBDatabase) => Promise<T>): Promise<T> => {
  const db = await openChatDb()
  try {
    return await run(db)
  } finally {
    db.close()
    activeDbs.delete(db)
  }
}

const idbReq = <T>(request: IDBRequest<T>): Promise<T> =>
  new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })

const idbTxDone = (tx: IDBTransaction): Promise<void> =>
  new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
    tx.onabort = () => reject(tx.error ?? new Error('Transaksi IndexedDB dibatalkan'))
  })

const getOrCreateWrapKey = async (db: IDBDatabase, userId: string): Promise<CryptoKey> => {
  const existing = await idbReq<CryptoKey | undefined>(
    db.transaction(STORES.wrapKeys, 'readonly').objectStore(STORES.wrapKeys).get(userId),
  )
  if (existing) return existing

  const generated = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'])
  const tx = db.transaction(STORES.wrapKeys, 'readwrite')
  tx.objectStore(STORES.wrapKeys).put(generated, userId)
  await idbTxDone(tx)
  return generated
}

const sealJson = async (key: CryptoKey, value: unknown): Promise<{ iv: Uint8Array; data: ArrayBuffer }> => {
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const plain = new TextEncoder().encode(JSON.stringify(value))
  const data = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, plain)
  plain.fill(0)
  return { iv, data }
}

const openJson = async <T>(key: CryptoKey, iv: Uint8Array, data: ArrayBuffer): Promise<T | null> => {
  try {
    const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: new Uint8Array(iv) }, key, data)
    return JSON.parse(new TextDecoder().decode(plain)) as T
  } catch {
    return null
  }
}

const deleteByUserIndex = (store: IDBObjectStore, userId: string): Promise<void> =>
  new Promise((resolve, reject) => {
    const req = store.index('by_user').openCursor(IDBKeyRange.only(userId))
    req.onsuccess = () => {
      const cursor = req.result
      if (!cursor) {
        resolve()
        return
      }
      cursor.delete()
      cursor.continue()
    }
    req.onerror = () => reject(req.error)
  })

const deleteByConvIndex = (store: IDBObjectStore, userId: string, conversationId: string): Promise<void> =>
  new Promise((resolve, reject) => {
    const req = store.index('by_conv').openCursor(IDBKeyRange.only([userId, conversationId]))
    req.onsuccess = () => {
      const cursor = req.result
      if (!cursor) {
        resolve()
        return
      }
      cursor.delete()
      cursor.continue()
    }
    req.onerror = () => reject(req.error)
  })

/** Simpan daftar percakapan ke IndexedDB Chrome (terenkripsi AES-GCM). */
export const saveLocalConversations = async (userId: string, list: Conversation[]): Promise<void> => {
  if (!isSupported() || !userId) return
  await withDb(async (db) => {
    const wrapKey = await getOrCreateWrapKey(db, userId)
    const sealedList = await Promise.all(
      list.map(async (conv) => {
        const sealed = await sealJson(wrapKey, conv)
        return {
          cacheKey: `${userId}:${conv.id}`,
          userId,
          conversationId: conv.id,
          iv: sealed.iv,
          data: sealed.data,
          updatedAt: Date.now(),
        } satisfies EncryptedRecord
      }),
    )

    const tx = db.transaction(STORES.conversations, 'readwrite')
    const store = tx.objectStore(STORES.conversations)
    await deleteByUserIndex(store, userId)
    for (const row of sealedList) store.put(row)
    await idbTxDone(tx)
  })
}

/** Muat daftar percakapan yang tersimpan di IndexedDB Chrome. */
export const loadLocalConversations = async (userId: string): Promise<Conversation[]> => {
  if (!isSupported() || !userId) return []
  return withDb(async (db) => {
    const wrapKey = await idbReq<CryptoKey | undefined>(
      db.transaction(STORES.wrapKeys, 'readonly').objectStore(STORES.wrapKeys).get(userId),
    )
    if (!wrapKey) return []

    const records = await idbReq<EncryptedRecord[]>(
      db.transaction(STORES.conversations, 'readonly').objectStore(STORES.conversations).index('by_user').getAll(userId),
    )
    const decoded = await Promise.all(records.map((r) => openJson<Conversation>(wrapKey, r.iv, r.data)))
    return decoded
      .filter((c): c is Conversation => c !== null)
      .sort((a, b) => {
        if (a.pinned !== b.pinned) return a.pinned ? -1 : 1
        return String(b.last_message_at ?? '').localeCompare(String(a.last_message_at ?? ''))
      })
  }).catch(() => [])
}

/** Simpan atau perbarui pesan percakapan ke IndexedDB Chrome (terenkripsi AES-GCM). */
export const saveLocalMessages = async (
  userId: string,
  conversationId: string,
  messages: ChatMessage[],
): Promise<void> => {
  if (!isSupported() || !userId || !conversationId || messages.length === 0) return
  await withDb(async (db) => {
    const wrapKey = await getOrCreateWrapKey(db, userId)
    const sealedRows = await Promise.all(
      messages.map(async (msg) => {
        const sealed = await sealJson(wrapKey, msg)
        return {
          cacheKey: `${userId}:${conversationId}:${msg.client_msg_id}`,
          userId,
          conversationId,
          seq: msg.seq,
          iv: sealed.iv,
          data: sealed.data,
          updatedAt: Date.now(),
        } satisfies EncryptedRecord
      }),
    )

    const tx = db.transaction(STORES.messages, 'readwrite')
    const store = tx.objectStore(STORES.messages)
    for (const row of sealedRows) store.put(row)
    await idbTxDone(tx)
  })
}

/** Muat pesan lokal dan daftar penanda pesan yang pernah dihapus lokal untuk satu percakapan. */
export const loadLocalConversationState = async (
  userId: string,
  conversationId: string,
): Promise<{ messages: ChatMessage[]; deletedIds: Set<string>; clearedUpToSeq: number }> => {
  const empty = { messages: [], deletedIds: new Set<string>(), clearedUpToSeq: 0 }
  if (!isSupported() || !userId || !conversationId) return empty

  return withDb(async (db) => {
    const tx = db.transaction([STORES.wrapKeys, STORES.messages, STORES.deletedMsgs, STORES.clearedConv], 'readonly')
    const [wrapKey, msgRecords, delRecords, clearedRecord] = await Promise.all([
      idbReq<CryptoKey | undefined>(tx.objectStore(STORES.wrapKeys).get(userId)),
      idbReq<EncryptedRecord[]>(tx.objectStore(STORES.messages).index('by_conv').getAll([userId, conversationId])),
      idbReq<DeletedMsgRecord[]>(tx.objectStore(STORES.deletedMsgs).index('by_conv').getAll([userId, conversationId])),
      idbReq<ClearedConvRecord | undefined>(tx.objectStore(STORES.clearedConv).get(`${userId}:${conversationId}`)),
    ])

    const deletedIds = new Set(delRecords.map((r) => r.clientMsgId))
    const clearedUpToSeq = clearedRecord?.clearedUpToSeq ?? 0
    if (!wrapKey) return { messages: [], deletedIds, clearedUpToSeq }

    const decoded = await Promise.all(msgRecords.map((r) => openJson<ChatMessage>(wrapKey, r.iv, r.data)))
    const messages = decoded
      .filter((m): m is ChatMessage => m !== null && !deletedIds.has(m.client_msg_id) && m.seq > clearedUpToSeq)
      .sort((a, b) => a.seq - b.seq)

    return { messages, deletedIds, clearedUpToSeq }
  }).catch(() => empty)
}

/** Pemakaian cache per percakapan: jumlah pesan, ukuran terenkripsi, dan seq terakhir untuk batas hapus. */
export const getLocalConversationUsage = async (userId: string): Promise<LocalConversationUsage[]> => {
  if (!isSupported() || !userId) return []
  return withDb(async (db) => {
    const tx = db.transaction([STORES.wrapKeys, STORES.conversations, STORES.messages], 'readonly')
    const [wrapKey, convRecords, msgRecords] = await Promise.all([
      idbReq<CryptoKey | undefined>(tx.objectStore(STORES.wrapKeys).get(userId)),
      idbReq<EncryptedRecord[]>(tx.objectStore(STORES.conversations).index('by_user').getAll(userId)),
      idbReq<EncryptedRecord[]>(tx.objectStore(STORES.messages).index('by_user').getAll(userId)),
    ])

    const usage = new Map<string, LocalConversationUsage>()
    for (const r of msgRecords) {
      const id = r.conversationId ?? ''
      const item = usage.get(id) ?? { conversationId: id, label: '', messages: 0, bytes: 0, maxSeq: 0 }
      item.messages += 1
      item.bytes += r.data.byteLength
      item.maxSeq = Math.max(item.maxSeq, r.seq ?? 0)
      usage.set(id, item)
    }
    if (wrapKey) {
      for (const r of convRecords) {
        const item = usage.get(r.conversationId ?? '')
        const conv = item ? await openJson<Conversation>(wrapKey, r.iv, r.data) : null
        if (item && conv) item.label = peerLabel(conv)
      }
    }
    return [...usage.values()].sort((a, b) => b.bytes - a.bytes)
  }).catch(() => [])
}

/** Hapus seluruh riwayat satu percakapan di IndexedDB Chrome (pola waClear scaner_sca_sast). */
export const clearLocalConversation = async (
  userId: string,
  conversationId: string,
  upToSeq = 0,
): Promise<void> => {
  if (!isSupported() || !userId || !conversationId) return
  await withDb(async (db) => {
    const tx = db.transaction([STORES.messages, STORES.deletedMsgs, STORES.clearedConv], 'readwrite')
    const msgStore = tx.objectStore(STORES.messages)
    const delStore = tx.objectStore(STORES.deletedMsgs)
    const clrStore = tx.objectStore(STORES.clearedConv)

    const existingCleared = await idbReq<ClearedConvRecord | undefined>(clrStore.get(`${userId}:${conversationId}`))
    await deleteByConvIndex(msgStore, userId, conversationId)
    await deleteByConvIndex(delStore, userId, conversationId)
    clrStore.put({
      cacheKey: `${userId}:${conversationId}`,
      userId,
      conversationId,
      clearedUpToSeq: Math.max(existingCleared?.clearedUpToSeq ?? 0, upToSeq),
      clearedAt: Date.now(),
    } satisfies ClearedConvRecord)
    await idbTxDone(tx)
  })
}

/** Bersihkan seluruh cache chat di IndexedDB Chrome tanpa menghapus kunci privat E2EE (keyring). */
export const clearAllLocalChats = async (userId?: string): Promise<void> => {
  if (!isSupported()) return
  await withDb(async (db) => {
    const storeNames = [STORES.conversations, STORES.messages, STORES.deletedMsgs, STORES.clearedConv]
    const tx = db.transaction(storeNames, 'readwrite')
    if (userId) {
      await Promise.all(storeNames.map((name) => deleteByUserIndex(tx.objectStore(name), userId)))
    } else {
      for (const name of storeNames) tx.objectStore(name).clear()
    }
    await idbTxDone(tx)
  })
}

const clearAndDeleteDatabase = async (dbName: string, storeNames: string[]): Promise<void> => {
  await new Promise<void>((resolve) => {
    try {
      const req = indexedDB.open(dbName)
      req.onsuccess = () => {
        const db = req.result
        try {
          const existing = storeNames.filter((name) => db.objectStoreNames.contains(name))
          if (existing.length > 0) {
            const tx = db.transaction(existing, 'readwrite')
            for (const name of existing) tx.objectStore(name).clear()
            tx.oncomplete = () => { db.close(); resolve() }
            tx.onerror = () => { db.close(); resolve() }
            tx.onabort = () => { db.close(); resolve() }
          } else {
            db.close()
            resolve()
          }
        } catch {
          try { db.close() } catch { /* abaikan */ }
          resolve()
        }
      }
      req.onerror = () => resolve()
      req.onblocked = () => resolve()
    } catch {
      resolve()
    }
  })

  await new Promise<void>((resolve) => {
    try {
      const del = indexedDB.deleteDatabase(dbName)
      const timer = setTimeout(resolve, 400)
      del.onsuccess = del.onerror = del.onblocked = () => {
        clearTimeout(timer)
        resolve()
      }
    } catch {
      resolve()
    }
  })
}

/**
 * Reset penuh penyimpanan lokal browser untuk seru24 (mengadopsi pola resetFullAll scaner_sca_sast):
 * membersihkan cache IndexedDB, localStorage seru24, dan sessionStorage, lalu deleteDatabase.
 */
export const resetFullLocalStorage = async (options?: { includeKeyring?: boolean }): Promise<void> => {
  const includeKeyring = options?.includeKeyring === true

  for (const db of activeDbs) {
    try { db.close() } catch { /* abaikan */ }
  }
  activeDbs.clear()

  try {
    const keysToRemove: string[] = []
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i)
      if (!key || !key.startsWith('seru24:')) continue
      if (!includeKeyring && key === VISITOR_KEY_STORAGE) continue
      keysToRemove.push(key)
    }
    for (const key of keysToRemove) localStorage.removeItem(key)
  } catch { /* abaikan */ }

  try {
    sessionStorage.clear()
  } catch { /* abaikan */ }

  if (!isSupported()) return

  await clearAndDeleteDatabase(CHAT_DB_NAME, [
    STORES.wrapKeys,
    STORES.conversations,
    STORES.messages,
    STORES.deletedMsgs,
    STORES.clearedConv,
  ])

  if (includeKeyring) {
    await clearAndDeleteDatabase(KEYRING_DB_NAME, [KEYRING_STORE])
  }
}

/** Hitung ringkasan jumlah data chat lokal dan estimasi penggunaan ruang browser. */
export const getLocalChatStorageStats = async (userId: string): Promise<LocalChatStorageStats> => {
  const empty: LocalChatStorageStats = { conversations: 0, messages: 0, usageBytes: null, quotaBytes: null }
  if (!isSupported() || !userId) return empty

  const counts = await withDb(async (db) => {
    const tx = db.transaction([STORES.conversations, STORES.messages], 'readonly')
    const [conversations, messages] = await Promise.all([
      idbReq<number>(tx.objectStore(STORES.conversations).index('by_user').count(userId)),
      idbReq<number>(tx.objectStore(STORES.messages).index('by_user').count(userId)),
    ])
    return { conversations, messages }
  }).catch(() => ({ conversations: 0, messages: 0 }))

  let usageBytes: number | null = null
  let quotaBytes: number | null = null
  try {
    const estimate = await navigator.storage?.estimate?.()
    if (estimate) {
      usageBytes = typeof estimate.usage === 'number' ? estimate.usage : null
      quotaBytes = typeof estimate.quota === 'number' ? estimate.quota : null
    }
  } catch { /* abaikan */ }

  return {
    conversations: counts.conversations,
    messages: counts.messages,
    usageBytes,
    quotaBytes,
  }
}
