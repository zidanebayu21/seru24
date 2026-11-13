export default defineNuxtConfig({
  compatibilityDate: '2025-07-15',
  devtools: { enabled: true },
  runtimeConfig: {
    // server-only, diisi dari SUPABASE_SERVICE_ROLE_KEY
    supabaseServiceRoleKey: '',
    public: {
      supabaseUrl: '',
      supabaseAnonKey: '',
    },
  },
})
