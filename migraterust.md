# migraterust.md — Panduan migrasi seru24 Android: React Native → Rust + Slint

Dokumen untuk agent pelaksana (Antigravity/"agy"). Baca SELURUHNYA sebelum menulis kode. Bahasa kode/komentar: Indonesia, mengikuti repo.

## 0. Aturan wajib (jangan dilanggar)

1. Kerja di branch **`dev-rust`**. Jangan sentuh `main`, jangan commit ke `main`, jangan push tanpa diminta pemilik.
2. **Jangan jalankan SQL/migrasi** ke Supabase. Kalau butuh perubahan DB, tulis file di `supabase/migrations/` lalu minta pemilik menjalankannya. Migrasi `20261120100000_seru24_offline_sent_at.sql` juga dijalankan pemilik, bukan agent.
3. Jangan ubah `web/`, `mobile/`, `supabase/` kecuali diminta. Aplikasi RN (`mobile/`) tetap jadi acuan perilaku dan **tidak dihapus** sampai paritas tercapai (Bagian 9).
4. Jangan commit rahasia. `mobile/src/env.ts` (dibuat `scripts/gen-env.js`) berisi anon key; salin nilainya lewat env/`build.rs`, jangan hardcode di repo Rust yang akan publik.
5. Pesan commit: pesan saja, tanpa baris "Co-Authored-By".
6. Kode harus lolos standar SonarQube: duplikasi minimal, tanpa import/variabel tak terpakai, fungsi kecil. Jalankan `cargo clippy -- -D warnings` dan `cargo fmt --check`.
7. Komentar keamanan merujuk RFC/ASVS/OWASP (lihat gaya di `web/shared/crypto.ts`).
8. Kalau ragu soal format byte/enkripsi, **jangan menebak**: baca `web/shared/crypto.ts` dan buat test vektor silang (Bagian 5.1).

## 1. Status dan kejujuran soal manfaat

- Sudah ada prototipe `rust/seru24-slint/` (desktop, data tiruan): exe 9,2 MB, RAM ±126 MB working set di Windows. **Itu bukan angka Android** dan belum dibandingkan dengan RN. Jangan menjanjikan penghematan RAM sebelum diukur (Fase 0).
- Risiko terbesar bukan performa, tapi: IME/keyboard & emoji di Slint Android, aksesibilitas, push FCM, Nearby Connections, WebRTC, dan lisensi Slint.
- **Lisensi Slint**: GPLv3 (wajib membuka kode aplikasi), atau "Royalty-free" (wajib menampilkan badge/atribusi Slint dan daftar), atau komersial berbayar. Pemilik harus memilih sebelum rilis publik. Catat pilihan di README.

Karena itu pekerjaan dibagi fase dengan **gerbang (gate)**: lanjut ke fase berikut hanya jika gerbang lulus.

## 2. Peta aplikasi yang harus ditiru

Sumber kebenaran logika ada di TypeScript bersama `web/shared/*.ts` (dipakai web dan mobile). Port ke Rust harus **identik perilakunya**.

| Area | Sumber TS (acuan) | Catatan |
|---|---|---|
| Kripto | `web/shared/crypto.ts`, `e2ee-core.ts` | X25519 + HKDF-SHA256 + AES-256-GCM; scrypt (N=2^15, r=8, p=1) → HKDF → `authSecret` & `wrapKey` |
| Akun/login | `account-core.ts`, `session-core.ts`, `pin-core.ts` | Password tidak pernah dikirim; yang dikirim `authSecret` |
| Chat/urutan | `chat-core.ts` | `messageTime()` = `offline_sent_at ?? created_at`; `compareBubbles` |
| Inbox | `inbox-core.ts` | daftar percakapan, belum dibaca |
| Presence/typing/call signal | `presence-core.ts` | channel Realtime privat `conv:<id>` |
| Telepon | `call-core.ts`, `call-quality-core.ts` | WebRTC 1-1, STUN Google, tanpa TURN |
| Mode Dekat | `nearby-core.ts` + `mobile/src/lib/nearby.ts` + Java native | Bluetooth only, Nearby Connections |
| Outbox offline | `mobile/src/lib/outbox.ts` | `sendWithOfflineTime`, fallback `PGRST202` |
| File/gambar | `file-core.ts`, `mobile/src/lib/files.ts` | via `API_BASE_URL` (Vercel `/api/files`) |
| Backup kunci | `backup-core.ts`, `mobile/src/lib/backup.ts` | |
| Tema | `theme-core.ts` | palet termasuk `revisedBg` (#ffe0e6 / #4a2830 / #4d2a28) |
| Update APK | `mobile/src/lib/update.ts`, `app-release.ts` | cek versi di `API_BASE_URL` |
| UI mobile | `mobile/src/screens/*` (Auth, ChatList, Chat 1421 baris, Nearby, NearbyChat) + `components/*` | |

RPC Supabase yang dipakai (semua `public.seru24_*`, dipanggil lewat PostgREST `/rest/v1/rpc/<nama>`):
`me, search_user, start_direct_chat, accept_chat, list_conversations, get_messages, send_message (p_offline_sent_at opsional), delete_message, mark_read, peer_read_seq, get_public_keys, set_initial_keys, register_device, trust_device, get_key_backup, block_user, unblock_user, register_push_token, unregister_push_token, schedule_message, list_scheduled, cancel_scheduled`.
Skema dan alur: `doc/database.md`, `doc/*.drawio`, `doc/keamanan-password-transport.md`. **Baca ketiganya.**

Backend (Supabase URL, anon key, `API_BASE_URL=https://seru24.vercel.app`) tidak berubah. Klien Rust hanya mengganti klien.

## 3. Arsitektur target

Satu crate **workspace** di `rust/`:

```
rust/
  Cargo.toml                 # workspace
  seru24-core/               # lib murni, TANPA UI, bisa di-test di desktop
    src/crypto.rs            # port crypto.ts
    src/e2ee.rs              # port e2ee-core.ts
    src/api.rs               # klien PostgREST + GoTrue (reqwest/rustls)
    src/realtime.rs          # klien Phoenix WebSocket (tokio-tungstenite)
    src/chat.rs inbox.rs outbox.rs theme.rs ...
    tests/vectors.rs         # vektor silang dengan TypeScript
  seru24-app/                # UI Slint + android_main
    ui/*.slint
    src/lib.rs               # #[no_mangle] android_main + main desktop
  seru24-slint/              # prototipe lama (boleh dihapus setelah Fase 1)
```

Prinsip: seluruh logika di `seru24-core` (test di PC, cepat). `seru24-app` hanya merangkai UI. Async: `tokio` (runtime kecil `rt` + `net`), UI thread tetap Slint; hasil dikirim balik lewat `slint::invoke_from_event_loop` / `Weak`.

Crate yang disarankan (verifikasi versi terbaru di crates.io, kunci di `Cargo.lock`):
- UI: `slint` (+ `slint-build`), fitur `backend-android-activity-06` untuk Android.
- HTTP: `reqwest` dengan `rustls-tls` (HINDARI openssl, menyulitkan cross-compile Android), `serde`, `serde_json`.
- Realtime: `tokio-tungstenite` (rustls) + `serde_json`.
- Kripto: `x25519-dalek`, `hkdf`, `sha2`, `aes-gcm`, `scrypt`, `rand`/`getrandom`, `base64`, `zeroize`.
- Penyimpanan lokal: `rusqlite` (bundled) atau file terenkripsi; kunci master di Android Keystore lewat JNI (`jni` crate) — meniru `react-native-keychain`.
- JNI: `jni` + `ndk-context`.

## 4. Siapkan lingkungan (Windows)

Sudah ada di mesin pemilik: Rust 1.99.1 (target Windows saja), Android SDK di `%LOCALAPPDATA%\Android\Sdk` dengan `emulator`, `platform-tools`, `ndk\27.1.12297006`, `system-images\android-35\...\x86_64`, AVD `Medium_Phone_API_35`.

Perintah (PowerShell). **Minta izin pemilik sebelum menginstal** (mengubah toolchain):

```powershell
rustup target add aarch64-linux-android x86_64-linux-android
cargo install cargo-ndk
cargo install cargo-apk        # atau xbuild; pilih satu, lihat Bagian 6
$env:ANDROID_HOME     = "$env:LOCALAPPDATA\Android\Sdk"
$env:ANDROID_NDK_HOME = "$env:ANDROID_HOME\ndk\27.1.12297006"
$env:Path += ";$env:ANDROID_HOME\platform-tools;$env:ANDROID_HOME\emulator"
```

Penting soal ABI:
- **Emulator** pakai image **x86_64** → target `x86_64-linux-android`.
- **HP asli** pakai `aarch64-linux-android` (arm64-v8a). Aplikasi RN juga arm64-only.
- Jangan campur: APK x86_64 tidak jalan di HP, APK arm64 tidak jalan di emulator x86_64.

## 5. Fase kerja

### Fase 0 — Ukur & gerbang (WAJIB dulu)
1. Jadikan prototipe `rust/seru24-slint` dapat dibangun ke Android (Bagian 6) dan jalankan di emulator **dan** HP asli.
2. Ukur RAM (Bagian 7) prototipe vs APK RN rilis 1.25 (pasang keduanya, kondisi sama: daftar chat terbuka, idle 30 dtk).
3. Uji manual: ketik di LineEdit (keyboard muncul? IME Indonesia? emoji? tempel/seleksi teks? scroll 500 pesan halus?).
- **Gerbang 0**: lanjut hanya jika (a) keyboard + emoji + seleksi teks berfungsi, (b) RAM/APK tidak lebih buruk dari RN, (c) pemilik setuju pilihan lisensi. Jika gagal, **berhenti dan laporkan** angkanya; jangan lanjut memaksakan.

### Fase 1 — `seru24-core`: kripto (tanpa UI)
Port `crypto.ts` + `e2ee-core.ts` ke Rust. **Kompatibilitas byte-per-byte dengan TS adalah syarat mutlak**, karena pesan lama dan pengguna web harus tetap bisa saling baca.

5.1 Vektor silang (cara anti-salah):
1. Buat skrip Node kecil (di `rust/seru24-core/tests/gen_vectors.mjs`, TIDAK mengubah `web/`) yang mengimpor `web/shared/crypto.ts` (lewat `tsx`) dan mencetak JSON: untuk input tetap (password, salt, conversationId, kunci privat tetap, nonce tetap bila fungsi mengizinkan) → `authSecret`, `wrapKey`, kunci percakapan, ciphertext, nonce, safetyCode.
2. Simpan JSON ke `tests/vectors.json` (data uji, bukan rahasia asli — pakai nilai karangan).
3. Test Rust memuat JSON dan menegaskan hasil **identik**; juga uji arah sebaliknya: Rust mengenkripsi → Node mendekripsi (jalankan skrip Node kedua).
4. Perhatikan detail yang sering salah: varian base64 (`toBase64` vs `toBase64Url`), normalisasi `password.normalize('NFKC')`, `salt = conversation_id` untuk HKDF, string `info` (`seru24/v1/msg`, `seru24/v1/auth`, `seru24/v1/keywrap`), AAD (`seru24/v1/backup`, dan AAD konteks pesan = conversationId/senderId/clientMsgId/kind — baca `MessageContext` di `crypto.ts` untuk urutan/format pastinya), nonce 12 byte, `MAX_TEXT_LENGTH = 4000`, scrypt `N=2^15, r=8, p=1`.
5. Zeroize kunci setelah dipakai (ASVS V6), CSPRNG untuk kunci/nonce.
- **Gerbang 1**: semua vektor lulus dua arah. Tanpa ini jangan lanjut.

### Fase 2 — `seru24-core`: jaringan
- `api.rs`: login GoTrue (`POST {SUPABASE_URL}/auth/v1/token?grant_type=password`, header `apikey`), refresh token, panggil RPC dengan `Authorization: Bearer <access_token>`. Tiru alur di `account-core.ts` dan `session-core.ts` (login username → email, password → `authSecret`).
- Penanganan error: `PGRST202` pada `send_message` → ulangi tanpa `p_offline_sent_at` (lihat `outbox.ts`).
- `realtime.rs`: protokol Phoenix (`wss://<proyek>.supabase.co/realtime/v1/websocket?apikey=...&vsn=1.0.0`), join channel privat `conv:<id>` dengan `config.private=true`, `broadcast` (event `typing`, `call`), `presence`, heartbeat 30 dtk, reconnect eksponensial. Acuan: `presence-core.ts`. Policy RLS di `realtime.messages` sudah ada di server.
- `outbox.rs`: antrean offline persisten, kirim ulang saat online, simpan `queuedAt` sebagai `offline_sent_at`.
- Uji dengan akun uji di `test_account.txt` (JANGAN salin isinya ke repo/dokumen). Bila perlu mock server `wiremock`.
- **Gerbang 2**: CLI desktop kecil (`cargo run -p seru24-core --example cli`) bisa login, daftar percakapan, kirim, dan baca pesan yang dikirim dari web, serta sebaliknya.

### Fase 3 — UI Slint (`seru24-app`)
Urutan layar (satu per satu, tiap layar dites di emulator):
1. `AuthScreen` (login/daftar, PIN bila ada di `pin-core.ts`).
2. `ChatListScreen` (daftar, belum dibaca, cari, pesan permintaan).
3. `ChatScreen` (bubble, balasan, hapus, baca/centang, **bubble revisi pink**, kirim, kirim terjadwal, lampiran).
4. Tema (terang/gelap/cokelat dari `theme-core.ts`; tetapkan token warna sebagai `global` Slint, jangan hardcode berulang → hindari duplikasi).
5. Akun/menu, backup kunci, perangkat tepercaya.
Gunakan komponen Slint bersama (`component` + `global Theme`), virtualisasi lewat `ListView`. Prototipe `ui/app.slint` adalah titik awal.

### Fase 4 — Fitur platform (butuh JNI / Kotlin)
- **Push FCM**: FCM tidak bisa dari Rust murni. Pertahankan Java/Kotlin `FirebaseMessagingService` kecil yang meneruskan token/payload ke Rust lewat JNI; registrasi token via `seru24_register_push_token`. Lihat `mobile/src/lib/notify.ts` dan `web/server/api/push`.
- **Notifikasi, izin runtime, Keystore, scrypt native**: meniru modul Java yang ada di `mobile/android/app/src/main/java/com/id.seru24.chat/`. Boleh dipakai ulang lewat JNI. (Scrypt Rust sudah cukup cepat; `nativeScrypt.ts` ada karena Hermes lambat, tidak perlu di Rust.)
- **Mode Dekat (Nearby Connections)**: Play Services API hanya Java/Kotlin → bungkus modul Java yang ada, panggil lewat JNI, kirim event ke Rust lewat callback. Logika protokol `nearby-core.ts` di-port ke Rust.
- **Berkas/gambar**: picker lewat intent Android (JNI); unggah ke `API_BASE_URL/api/files` seperti `files.ts`.
- **Update APK**: port `update.ts`.

### Fase 5 — Telepon (paling berisiko, terakhir)
Opsi (pilih setelah Gerbang 3, diskusikan dengan pemilik):
- A. Pakai `webrtc-rs` (belum tentu matang untuk Android, audio device sendiri sulit).
- B. Pertahankan WebRTC Android resmi (lib `org.webrtc` di Kotlin) dan kendalikan dari Rust lewat JNI; sinyal (`invite/accept/.../record`) tetap di `call-core` versi Rust.
Rekomendasi: **B**. Port mesin status `call-core.ts` (fase: idle, calling, incoming, connecting, connected; timeout dering 45 dtk, callee diam). Kualitas 16/32/64/128 kbps lewat `RTCRtpSender.setParameters`. Speaker/earpiece lewat `CallAudioModule.java` yang sudah ada. Rekam lokal tidak ada di Android (sama seperti sekarang).

## 6. Membangun Slint untuk Android

Slint (dokumen resmi "Slint on Android", cek versi terbaru sebelum menulis — API bisa berubah):
- `Cargo.toml` aplikasi: `crate-type = ["cdylib"]` (lib) + `slint = { version = "1", default-features = false, features = ["backend-android-activity-06", "compat-1-2", "renderer-femtovg"] }`. Verifikasi nama fitur di dokumentasi versi yang terpasang.
- `src/lib.rs`:
  ```rust
  #[cfg(target_os = "android")]
  #[no_mangle]
  fn android_main(app: slint::android::AndroidApp) {
      slint::android::init(app).unwrap();
      run_app();           // sama dengan main desktop
  }
  ```
  dan `fn main()` desktop memanggil `run_app()` juga. Satu basis kode untuk desktop (cepat diuji) dan Android.
- Paket APK: `cargo apk` (konfigurasi `[package.metadata.android]` di Cargo.toml: `package`, `build_targets`, `uses_permission`, `min_sdk_version`, `target_sdk_version`) **atau** `xbuild`. Slint merekomendasikan salah satunya; pilih yang jalan di Windows dan catat pilihannya di README. Bila butuh kelas Java/Kotlin (FCM, Nearby) → pakai proyek Gradle sendiri dan muat `.so` lewat `NativeActivity`/`GameActivity` (`cargo ndk -t arm64-v8a -o app/src/main/jniLibs build --release`), karena `cargo-apk` tidak mengompilasi Java.
- Tanda tangan rilis: jangan pakai debug key untuk rilis. Tanda tangani dengan keystore pemilik (lihat cara `mobile/build.ps1` / `release_apk.ps1` memakainya; **jangan** menyalin kata sandi keystore).
- `applicationId` harus sama dengan RN (`id.seru24.chat`) bila ingin menimpa/upgrade aplikasi lama, DAN keystore penandatanganan harus sama. Untuk uji, gunakan id berbeda (mis. `id.seru24.chat.rust`) agar tidak menimpa aplikasi produksi.

## 7. Cara pakai emulator (ajaran langkah demi langkah)

```powershell
$sdk = "$env:LOCALAPPDATA\Android\Sdk"
& "$sdk\emulator\emulator.exe" -list-avds                # lihat AVD: Medium_Phone_API_35
& "$sdk\emulator\emulator.exe" -avd Medium_Phone_API_35 -no-snapshot-save   # jalankan (biarkan terbuka / background)
& "$sdk\platform-tools\adb.exe" devices                  # tunggu status "device", bukan "offline"
& "$sdk\platform-tools\adb.exe" shell getprop sys.boot_completed   # keluar 1 = siap
```

Pasang & jalankan:
```powershell
adb install -r path\ke\app.apk               # -r = timpa, data tetap
adb shell am start -n id.seru24.chat.rust/android.app.NativeActivity
adb uninstall id.seru24.chat.rust
```

Log (sangat penting saat crash/layar putih):
```powershell
adb logcat -c
adb logcat *:E RustStdoutStderr:V slint:V AndroidRuntime:E DEBUG:V   # error + stdout Rust
```
Bila aplikasi langsung tertutup: cari "FATAL EXCEPTION" atau "SIGSEGV"/"UnsatisfiedLinkError" (biasanya ABI salah atau nama `android_main` tidak ter-export).

Ukur RAM:
```powershell
adb shell dumpsys meminfo id.seru24.chat.rust | Select-String "TOTAL PSS|Native Heap|Java Heap|Graphics"
adb shell dumpsys meminfo id.seru24.chat          # aplikasi RN, bandingkan
```
Pakai angka **TOTAL PSS** (KB) sesudah idle 30 detik di daftar chat; ulangi 3 kali, ambil median. Catat juga ukuran APK (`(Get-Item app.apk).Length`).

Cara yang biasa dipakai pemilik di repo ini (aplikasi RN, sebagai pembanding dan contoh alur):
- `mobile\build.ps1 -Emulator` membangun APK **x86_64** tanpa menaikkan versi, hasilnya `mobile\seru24-<versi>-emulator.apk` (sudah banyak contoh di folder `mobile\`, mis. `seru24-21-emulator.apk`). Tanpa `-Emulator` skrip itu **menaikkan versi** dan membangun arm64 untuk HP asli, jadi **jangan dijalankan tanpa `-Emulator` kecuali pemilik minta rilis**.
- Alurnya: build APK emulator → jalankan AVD → `adb install -r <apk>` → buka aplikasi → baca `adb logcat`. Ikuti pola yang sama untuk APK Rust: sediakan skrip `rust\build.ps1 -Emulator` (target `x86_64-linux-android`, tanpa menaikkan versi) dan tanpa `-Emulator` (target `aarch64-linux-android`), meniru `mobile\build.ps1` (set `ANDROID_HOME`, batas ukuran APK 20 MB, nama berkas `seru24-rust-<versi>[-emulator].apk`).
- Untuk membandingkan RAM, pasang APK RN emulator (`mobile\seru24-25-emulator.apk` bila ada, atau bangun dengan `-Emulator`) berdampingan dengan APK Rust di emulator yang sama, supaya kondisinya setara.
- Rilis ke pengguna tetap hanya lewat `release_apk.ps1` atas perintah pemilik.

Tips emulator:
- Keyboard fisik PC aktif lewat emulator; untuk uji IME/emoji pakai keyboard layar (Settings → System → Keyboard) dan **juga HP asli**, karena emulator tidak mewakili IME vendor.
- Tanpa Google Play di image `Medium_Phone` (AOSP/`google_apis`?): **Nearby Connections dan FCM butuh Google Play Services** → uji keduanya hanya di HP asli, atau pakai image "Google Play".
- Bluetooth/GPS tidak ada di emulator → Mode Dekat TIDAK bisa diuji di emulator.
- Mikrofon: Extended controls (…) → Microphone → "Virtual microphone uses host audio input" untuk uji telepon.
- Jaringan putus: Extended controls → Cellular/airplane mode, atau `adb shell svc wifi disable` untuk uji outbox offline.
- HP asli via USB: aktifkan Developer options → USB debugging → `adb devices`. Atau nirkabel: `adb pair` lalu `adb connect`.
- Emulator lambat/berat? Pastikan akselerasi (Hyper-V/WHPX aktif); `-gpu host`.

## 8. Pengujian (aturan "aman")

- Unit test `seru24-core` di desktop: `cargo test -p seru24-core` (tiap fase).
- Tes vektor silang kripto = syarat Gerbang 1 dan dijalankan ulang tiap mengubah kripto.
- Tes perilaku ekuivalen: salin skenario penting dari `web/test/shared/*.test.ts` dan `mobile/__tests__/*.test.ts` (outbox, urutan `compareBubbles`, `call-core`) menjadi tes Rust — hasil harus sama.
- Uji end-to-end manual di emulator: login → daftar chat → kirim/terima dengan akun web → putus jaringan, kirim, sambung (cek bubble pink + urutan tidak acak) → buka ulang aplikasi (sesi dipulihkan) → keluar.
- Cek keamanan: tidak ada kunci/password/token di log (`adb logcat`), tidak ada `unsafe` tanpa alasan, `cargo audit`, `cargo deny` (opsional).
- Jangan jalankan tes yang tidak perlu bila pemilik minta "cepat"; bila minta "aman", jalankan satu per satu seluruhnya.

## 9. Paritas dan cutover

Daftar periksa sebelum RN boleh digantikan (semua harus ✔):
- [ ] Login/daftar/ubah & reset password, PIN, backup & pemulihan kunci
- [ ] Kirim/terima teks, balasan, hapus, baca, terjadwal, lampiran gambar/berkas
- [ ] Bubble revisi pink + urutan offline benar; outbox offline
- [ ] Tema terang/gelap/cokelat
- [ ] Notifikasi push
- [ ] Mode Dekat
- [ ] Telepon 1-1 (speaker, bisu, kualitas per chat, peringatan "lawan merekam")
- [ ] Update APK in-app
- [ ] RAM dan ukuran APK terukur lebih baik/sama (Bagian 7)
- [ ] Lisensi Slint diselesaikan
Pengguna lama harus tetap bisa membaca pesan lama (kompatibilitas kripto sudah dijamin Gerbang 1). Rilis via alur `release_apk.ps1` hanya atas perintah pemilik.

## 10. Risiko yang harus dilaporkan segera (jangan disembunyikan)

1. Keyboard/IME/emoji/seleksi teks Slint di Android tidak memadai → hentikan, laporkan.
2. Dependensi yang mensyaratkan `openssl` gagal di cross-compile → ganti ke `rustls`.
3. Waktu kompilasi lama (build pertama prototipe 3m47 di desktop) → gunakan `sccache`, jangan hapus `target/` tanpa perlu.
4. Telepon/Nearby/FCM menuntut jembatan JNI besar → kemungkinan hasil akhirnya hibrida (Rust + Kotlin); ini normal, bukan kegagalan.
5. Ukuran APK dari multi-renderer Slint; pilih satu renderer.

## 11. Definition of done tiap fase

Kode dirapikan (`cargo fmt`, `clippy -D warnings`), tes lulus, tidak ada duplikasi/impor tak terpakai, README `rust/` diperbarui (cara build, cara jalankan emulator, hasil ukur), lalu **berhenti dan laporkan ke pemilik** sebelum fase berikutnya. Commit hanya atas permintaan.
