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
      // ikon seru24 (konsep B2: gelembung chat + "24"), sama dengan ikon aplikasi Android
      link: [{ rel: 'icon', type: 'image/svg+xml', href: '/favicon.svg' }],
      // pasang tema sebelum halaman tampil agar tidak berkedip (logika sama dengan composables/useTheme.ts)
      script: [{
        innerHTML: "try{var p=localStorage.getItem('seru24:theme');var d=matchMedia('(prefers-color-scheme: dark)').matches;document.documentElement.dataset.theme=p==='light'||p==='dark'||p==='brown'?p:d?'dark':'light'}catch(e){}",
      }],
    },
  },

  runtimeConfig: {
    // server-only, diisi dari SUPABASE_SERVICE_ROLE_KEY
    supabaseServiceRoleKey: '',
    // kunci privat X25519 (base64) untuk enkripsi payload browser <-> server; env NUXT_TRANSPORT_PRIVATE_KEY
    transportPrivateKey: '',
    // true = daftar tanpa email verifikasi (hanya masa uji, OWASP ASVS V2.1); env NUXT_AUTH_SKIP_EMAIL_CONFIRM
    authSkipEmailConfirm: false,
    // Kredensial FCM HTTP v1 (Firebase service account) untuk push notification ke HP; isi JSON atau 3 field terpisah.
    fcmServiceAccountJson: '',
    fcmProjectId: '',
    fcmClientEmail: '',
    fcmPrivateKey: '',
    // Cron non-Vercel & SMTP untuk laporan statistik harian; isi via CRON_SECRET / NUXT_SMTP_* / SMTP_*.
    cronSecret: '',
    // false = cron /api/cron/daily-stats tidak menjalankan apa pun (untuk deploy yang belum menyiapkan SMTP)
    smtpEnabled: true,
    smtpHost: '',
    smtpPort: '587',
    smtpSecure: '',
    smtpUser: '',
    smtpPass: '',
    smtpFrom: '',
    smtpTargetEmail: '',
    // OAuth Google Drive akun penyimpanan dokumen chat (NUXT_GDRIVE_*); hanya server.
    gdriveClientId: '',
    gdriveClientSecret: '',
    gdriveRefreshToken: '',
    public: {
      supabaseUrl: '',
      supabaseAnonKey: '',
      // OWASP ASVS V2.1.1 mensyaratkan minimal 12; NUXT_PUBLIC_PASSWORD_MIN_LENGTH hanya untuk masa uji
      passwordMinLength: 12,
      // status online & "sedang mengetik…" (Supabase Realtime presence); NUXT_PUBLIC_REALTIME_PRESENCE=false untuk
      // mematikan bila kuota pesan Realtime tier gratis mulai habis
      realtimePresence: true,
    },
  },

  routeRules: {
    // Semua halaman dirender di browser: kunci privat dan sesi tidak pernah ada di server.
    '/**': { ssr: false },
    // Batas percobaan login/daftar per IP (OWASP ASVS V2.2.1). Penyimpanan di memori per instance.
    '/api/auth/**': { security: { rateLimiter: { tokensPerInterval: 10, interval: 60_000 } } },
    '/api/push/**': { security: { rateLimiter: { tokensPerInterval: 60, interval: 60_000 } } },
    // Dokumen dikirim per potongan 3 MiB (FILE_CHUNK_BYTES): body boleh sedikit di atas batas bawaan 2 MB,
    // dan satu file 50 MB = 17 permintaan sehingga batas laju lebih longgar dari bawaan (OWASP ASVS V12.1.1, V11.1.4).
    '/api/files/**': {
      security: {
        requestSizeLimiter: { maxRequestSizeInBytes: 3_300_000, maxUploadFileRequestInBytes: 3_300_000 },
        rateLimiter: { tokensPerInterval: 300, interval: 60_000 },
      },
    },
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
