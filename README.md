# seru24

Aplikasi secure chat (pesan terenkripsi end-to-end).

- `web/` — Nuxt (deploy ke Vercel, root directory: `web`, https://seru24.vercel.app)
- `web/shared/` — kode bersama web dan mobile: kripto, enkripsi transport, sesi, akun, E2EE, realtime
- `mobile/` — React Native 0.88 tanpa Expo (Android), memakai `web/shared` lewat Metro
- `supabase/` — migrasi SQL (`migrations/`) dan skrip bantu (`scripts/`)
- `doc/` — rancangan database, keamanan password/transport, diagram alur (draw.io)
- Backend: Supabase (auth, database `seru24`, realtime)

## Setup

```bash
cd web && cp .env.example .env && npm install && npm run dev
cd mobile && cp .env.example .env && npm install && npm start
```

Isi `.env` sesuai `.env.example`. File `.env` tidak ikut git.

### Mobile (Android)

```powershell
cd mobile
.\build.ps1             # APK rilis arm64 -> mobile\seru24-<versi>.apk (gagal bila >= 20 MB)
.\build.ps1 -Emulator   # APK x86_64 untuk emulator Android Studio
```

- Butuh Android SDK dan JDK 17 (`android/gradle.properties`).
- Kunci rilis: `android/app/seru24-release.keystore` + `android/keystore.properties` (tidak ikut git, simpan cadangannya; tanpa kunci yang sama, pembaruan APK tidak bisa dipasang di atas versi lama).
- `src/env.ts` dibuat dari `mobile/.env` oleh `scripts/gen-env.js` (hanya nilai publik).
- Kunci chat dan penanda perangkat disimpan di Android Keystore (`react-native-keychain`).

## Alur kerja

- Setiap perubahan: jalankan `npm test` dan `npm run build` di `web/`.
- **Jika test dan build berhasil, langsung commit dan push ke `main`** (tanpa menunggu konfirmasi), lalu deploy ke Vercel.
- Jika test atau build gagal: jangan commit; perbaiki dulu.
- Migrasi SQL di `supabase/migrations/` dijalankan berurutan sesuai nama file, hanya dengan izin pemilik proyek.
