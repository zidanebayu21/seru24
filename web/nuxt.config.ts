export default defineNuxtConfig({
  compatibilityDate: '2025-07-15',
  devtools: { enabled: false },
  modules: ['nuxt-security'],
  css: ['~/assets/main.css'],

  app: {
    head: {
      title: 'seru24',
      htmlAttrs: { lang: 'id' },
      meta: [
        { name: 'viewport', content: 'width=device-width, initial-scale=1' },
        { name: 'description', content: 'seru24 — chat terenkripsi end-to-end' },
      ],
    },
  },

  runtimeConfig: {
    // server-only, diisi dari SUPABASE_SERVICE_ROLE_KEY
    supabaseServiceRoleKey: '',
    // kunci privat X25519 (base64) untuk enkripsi payload browser <-> server; env NUXT_TRANSPORT_PRIVATE_KEY
    transportPrivateKey: '',
    // true = daftar tanpa email verifikasi (hanya masa uji, OWASP ASVS V2.1); env NUXT_AUTH_SKIP_EMAIL_CONFIRM
    authSkipEmailConfirm: false,
    public: {
      supabaseUrl: '',
      supabaseAnonKey: '',
      // OWASP ASVS V2.1.1 mensyaratkan minimal 12; NUXT_PUBLIC_PASSWORD_MIN_LENGTH hanya untuk masa uji
      passwordMinLength: 12,
    },
  },

  routeRules: {
    // Semua halaman dirender di browser: kunci privat dan sesi tidak pernah ada di server.
    '/**': { ssr: false },
    // Batas percobaan login/daftar per IP (OWASP ASVS V2.2.1). Penyimpanan di memori per instance.
    '/api/auth/**': { security: { rateLimiter: { tokensPerInterval: 10, interval: 60_000 } } },
  },

  // Header keamanan (OWASP ASVS V14.4, V3.4)
  security: {
    nonce: true,
    // Isi pesan selalu dirender sebagai teks (tanpa v-html); validator ini menolak password yang mengandung "<".
    xssValidator: false,
    headers: {
      contentSecurityPolicy: {
        'default-src': ["'self'"],
        'script-src': ["'self'", "'nonce-{{nonce}}'", "'strict-dynamic'"],
        'style-src': ["'self'", "'unsafe-inline'"],
        'img-src': ["'self'", 'data:', 'blob:'],
        'connect-src': ["'self'", 'https://*.supabase.co', 'wss://*.supabase.co'],
        'font-src': ["'self'"],
        'object-src': ["'none'"],
        'base-uri': ["'none'"],
        'form-action': ["'self'"],
        'frame-ancestors': ["'none'"],
        'upgrade-insecure-requests': true,
      },
      crossOriginEmbedderPolicy: 'credentialless',
      referrerPolicy: 'no-referrer',
      strictTransportSecurity: { maxAge: 31_536_000, includeSubdomains: true },
      permissionsPolicy: { camera: [], microphone: [], geolocation: [], 'display-capture': [] },
    },
  },
})
