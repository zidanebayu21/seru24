// Penghitung batas laju jendela tetap per kunci, disimpan di memori instance ini.
// Rujukan: OWASP ASVS V11.1.4 (anti-automation), V2.2.1; RFC 6585 §4 (429 Too Many Requests).

export interface RateLimitResult {
  allowed: boolean
  /** Detik sampai jendela berikutnya (untuk header Retry-After). */
  retryAfterSeconds: number
}

interface Bucket {
  windowStart: number
  count: number
}

export const createRateLimiter = (limit: number, windowMs: number, maxKeys = 50_000) => {
  const buckets = new Map<string, Bucket>()

  const prune = (now: number) => {
    for (const [key, bucket] of buckets) {
      if (now - bucket.windowStart >= windowMs) buckets.delete(key)
    }
    // masih penuh (banyak kunci aktif): buang yang tertua agar memori tetap terbatas
    for (const key of buckets.keys()) {
      if (buckets.size <= maxKeys) break
      buckets.delete(key)
    }
  }

  return (key: string, now = Date.now()): RateLimitResult => {
    let bucket = buckets.get(key)
    if (!bucket || now - bucket.windowStart >= windowMs) {
      bucket = { windowStart: now, count: 0 }
      buckets.set(key, bucket)
      if (buckets.size > maxKeys) prune(now)
    }
    bucket.count += 1
    return {
      allowed: bucket.count <= limit,
      retryAfterSeconds: Math.max(1, Math.ceil((bucket.windowStart + windowMs - now) / 1000)),
    }
  }
}
