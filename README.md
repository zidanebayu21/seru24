# seru24

Aplikasi secure chat (pesan terenkripsi end-to-end), web + Android.

- `web/` — Nuxt (deploy ke Vercel, root directory: `web`, https://seru24.vercel.app)
- `web/shared/` — kode bersama web dan mobile: kripto, enkripsi transport, sesi, akun, E2EE, realtime, dokumen
- `mobile/` — React Native 0.88 tanpa Expo (Android 10+), memakai `web/shared` lewat Metro
- `supabase/` — migrasi SQL (`migrations/`) dan skrip bantu (`scripts/`)
- `doc/` — rancangan database, keamanan password/transport, diagram alur (draw.io)
- `release_apk.ps1` — build APK rilis lalu unggah ke Google Drive (link tetap) + info versi untuk pembaruan di aplikasi

## Deploy di tempat lain

Semua konfigurasi ada di **`web/.env.example`** (server + web) dan **`mobile/.env.example`** (Android), lengkap
dengan komentar **WAJIB / OPSIONAL**. Salin ke `.env` masing-masing; file `.env` tidak ikut git.

### Yang dibutuhkan

| Layanan | Wajib? | Untuk apa | Bila tidak ada |
|---|---|---|---|
| **Supabase** (tier gratis cukup) | Wajib | Auth, database `seru24`, Realtime | Aplikasi tidak jalan |
| **Vercel** (atau hosting Node lain) | Wajib | Server Nuxt: halaman web + `/api/*` | — |
| **Node.js 22+** | Wajib | Build web dan mobile | — |
| **GitHub Actions** | Opsional | Cron Senin & Kamis (statistik, retensi DB, bersihkan dokumen, email) | Cron dilewati (tidak gagal) |
| **SMTP** (mis. Gmail + App Password) | Opsional | Email laporan cron | Isi `NUXT_SMTP_ENABLED=false`: cron tidak menjalankan apa pun |
| **Google Drive API** (OAuth akun penyimpanan) | Opsional | Kirim dokumen di chat (maks 50 MB) + rilis APK | Kirim dokumen menampilkan "belum dikonfigurasi" |
| **Firebase (FCM)** | Opsional | Push notification Android saat aplikasi ditutup | Tidak ada notifikasi saat aplikasi ditutup |
| **Android SDK + JDK 17** | Opsional | Build APK | Hanya versi web |

### Langkah

1. **Supabase**
   - Buat proyek, lalu jalankan semua file `supabase/migrations/*.sql` **berurutan sesuai nama file**
     (SQL Editor, atau `psql` dengan `SUPABASE_DB_*` dari `web/.env`).
   - Authentication → URL Configuration: isi *Site URL* dengan domain web, dan tambahkan
     `https://<domain>/reset-password` serta `https://<domain>/login` ke *Redirect URLs*
     (tautan verifikasi email dan reset password).
   - Tanpa SMTP di Supabase, email verifikasi terbatas; untuk masa uji bisa `NUXT_AUTH_SKIP_EMAIL_CONFIRM=true`.
2. **Web lokal**
   ```bash
   cd web && cp .env.example .env    # isi bagian WAJIB
   npm install && npm run dev        # http://localhost:3000
   npm test && npm run build
   ```
3. **Vercel**
   - Import repo, **Root Directory: `web`**, framework Nuxt.
   - Salin semua variabel dari `web/.env` ke Environment Variables (Production).
   - Setiap push ke `main` otomatis deploy.
4. **Cron (opsional)** — di GitHub repo → Settings → Secrets → Actions:
   - `CRON_SECRET` = sama dengan `NUXT_CRON_SECRET`
   - `SERU24_URL` = domain web, bila bukan `https://seru24.vercel.app`
   - Jadwal: `.github/workflows/daily-stats-cron.yml` (Senin & Kamis 01:00 UTC). Tanpa `CRON_SECRET` workflow dilewati.
5. **Android (opsional)** — lihat bagian berikut. Isi `mobile/.env` (`API_BASE_URL` = domain web).

### Test dan SonarQube

- **Web:** semua test ada di `web/test/` dengan struktur folder sama seperti kode yang diuji (`web/test/shared` untuk
  `web/shared`, `web/test/server/utils` untuk `web/server/utils`). Jalankan `npm test` atau `npm run test:coverage`
  (menulis `web/coverage/lcov.info`).
- **Mobile:** test ada di `mobile/__tests__/`. Jalankan `npx jest` atau `npx jest --coverage` di `mobile/`.
- **SonarQube:** `sonar-project.properties` di root memetakan sumber (`sonar.sources`) dan test (`sonar.tests`) web dan mobile.
  Buat laporan coverage dulu, lalu jalankan `sonar-scanner` dari root repo dengan `SONAR_TOKEN` di environment.

### Rahasia yang harus disimpan sendiri (tidak ada di repo)

- `web/.env` (service role key, kunci transport, SMTP, Google Drive, FCM)
- `mobile/.env`
- `mobile/android/app/seru24-release.keystore` + `mobile/android/keystore.properties` — **wajib dicadangkan**;
  tanpa kunci yang sama, pembaruan APK tidak bisa dipasang di atas versi lama.
- `mobile/android/app/google-services.json` (bila memakai FCM)

## Mobile (Android)

```powershell
cd mobile
copy .env.example .env    # isi SUPABASE_URL, SUPABASE_ANON_KEY, API_BASE_URL
npm install
.\build.ps1               # APK rilis arm64 -> mobile\seru24-<versi>.apk (naikkan versi otomatis)
.\build.ps1 -Emulator     # APK x86_64 untuk emulator Android Studio
cd ..; .\release_apk.ps1  # build + unggah ke Google Drive (butuh NUXT_GDRIVE_* di web/.env)
```

- Butuh Android SDK dan JDK 17 (`android/gradle.properties`); minimal Android 10.
- Kunci rilis: buat sekali dengan `keytool -genkeypair -v -keystore android/app/seru24-release.keystore -alias seru24 -keyalg RSA -keysize 2048 -validity 10000`,
  lalu `android/keystore.properties` berisi `storeFile`, `storePassword`, `keyAlias`, `keyPassword`.
- `src/env.ts` dibuat dari `mobile/.env` oleh `scripts/gen-env.js` (hanya nilai publik; ikut masuk APK).
- Kunci chat dan penanda perangkat disimpan di Android Keystore (`react-native-keychain`).
- Push notification: taruh `google-services.json` dari Firebase di `android/app/` (tanpa file ini build tetap jalan).

## Alur kerja

- Setiap perubahan: jalankan `npm test` dan `npm run build` di `web/` (dan `npx jest` di `mobile/` bila menyentuh mobile).
- **Jika test dan build berhasil, langsung commit dan push ke `main`** (tanpa menunggu konfirmasi); Vercel deploy otomatis.
- Jika test atau build gagal: jangan commit; perbaiki dulu.
- Migrasi SQL di `supabase/migrations/` dijalankan berurutan sesuai nama file, hanya dengan izin pemilik proyek.
- Rilis Android: `.\release_apk.ps1`; aplikasi versi lama menampilkan banner "Versi baru" dan bisa memperbarui langsung.
