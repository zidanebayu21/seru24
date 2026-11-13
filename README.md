# seru24

Aplikasi secure chat (pesan terenkripsi end-to-end).

- `web/` — Nuxt (deploy ke Vercel, root directory: `web`, https://seru24.vercel.app)
- `mobile/` — React Native (Expo)
- `supabase/` — migrasi SQL (`migrations/`) dan skrip bantu (`scripts/`)
- `doc/` — rancangan database, keamanan password/transport, diagram alur (draw.io)
- Backend: Supabase (auth, database `seru24`, realtime)

## Setup

```bash
cd web && cp .env.example .env && npm install && npm run dev
cd mobile && cp .env.example .env && npm install && npm start
```

Isi `.env` sesuai `.env.example`. File `.env` tidak ikut git.

## Alur kerja

- Setiap perubahan: jalankan `npm test` dan `npm run build` di `web/`.
- **Jika test dan build berhasil, langsung commit dan push ke `main`** (tanpa menunggu konfirmasi), lalu deploy ke Vercel.
- Jika test atau build gagal: jangan commit; perbaiki dulu.
- Migrasi SQL di `supabase/migrations/` dijalankan berurutan sesuai nama file, hanya dengan izin pemilik proyek.
