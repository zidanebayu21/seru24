import { toBase64Url } from '#shared/crypto'

/** Kunci publik transport server; browser memakainya untuk mengenkripsi payload /api/auth/*. */
export default defineLoggedHandler(async (event) => {
  const { publicKey, keyId } = transportKeys(event)
  setResponseHeader(event, 'cache-control', 'public, max-age=300')
  return { key_id: keyId, public_key: toBase64Url(publicKey) }
}, { rejectedEvent: false })
