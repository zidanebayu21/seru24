# mobile-rust

> **Status: eksperimen, dihentikan.** Aplikasi Rust + Slint ini **cepat** (ringan dan responsif), tetapi **masih banyak bug dan belum kompatibel** dengan aplikasi utama (izin Android, Nearby, telepon, notifikasi, dan lainnya belum stabil). Tidak dilanjutkan dan dibiarkan apa adanya. Aplikasi yang dipakai dan dirawat tetap `mobile/` (React Native).

Migrasi aplikasi Android seru24 ke Rust + Slint (branch `dev-rust`). Panduan lengkap: `../migraterust.md`.
Folder `mobile/` (React Native) tidak diubah dan tetap menjadi acuan perilaku.

## Status saat ini

- **Fase 0–5**: Selesai dibangun dan diverifikasi di desktop (`cargo fmt --check`, `cargo clippy --all-targets -- -D warnings`, `cargo test`, `cli check-db`) serta di emulator `Medium_Phone_API_35` (`emulator-5554`, `id.seru24.chat.rust` via Gradle 9.4.1 + `cargo-ndk`, R8/proguard aktif).
- **Lisensi**: **GPLv3 (`GPL-3.0-only`)** — dipilih oleh pemilik sebagai aplikasi komunitas sumber terbuka non-komersial ([LICENSE](LICENSE), tercantum di `Cargo.toml`).
- **Menunggu uji perangkat fisik**: Uji di HP Android `arm64-v8a` via USB untuk audio mikrofon telepon WebRTC real, Nearby Connections fisik antar dua perangkat, dan IME vendor Android.

## Hasil ukur build final Gradle (`arm64-v8a` & `emulator-5554` `x86_64`)

| Metrik | Rust + Slint (`id.seru24.chat.rust`, build penuh) | React Native 1.25 (`id.seru24.chat`) |
|---|---|---|
| Ukuran APK arm64 (`release`) | **14,87 MB** (`15.594.634` B, `seru24-rust-2.apk` / Drive `seru24-rust.apk`, termasuk `WebRTC` `5,73 MiB` + `Skia` + Firebase + Nearby) | **16,12 MB** (`16.898.781` B, `mobile/seru24-25.apk`) |
| Ukuran APK emulator (`x86_64`) | **16,07 MB** (`seru24-rust-2-emulator.apk`) | **17,3 MB** (`mobile/seru24-25-emulator.apk`) |
| RAM idle daftar chat (3 sampel `TOTAL PSS`) | `52.017` / `59.839` / `59.827` KB (**median 59.827 KB / ~58,4 MB**; prototipe Fase 0: `48.234 KB`) | `69.745` / `99.714` / `99.792` KB (**median 99.714 KB / ~97,4 MB**) |
| RAM setelah buka layar chat | **61.092 KB (~59,7 MB)** (chat live tersinkron; prototipe Fase 0: `56.222 KB`) | **108.533 KB (~106,0 MB)** |
| Log error (`adb logcat`) | 0 `FATAL` / crash `AndroidRuntime` | — |
| Emoji & teks | Emoji sederhana, bendera `🇮🇩`, modifier kulit `👍🏽 👍🏿`, & ZWJ `👨‍👩‍👧 👩‍💻 ❤️‍🔥` tampil penuh tanpa menambah ukuran APK (registrasi `"Noto Color Emoji Flags"` sistem via `slint::fontique_012`) | Normal (Android View) |

## Arsitektur workspace

- `seru24-core/`: library murni tanpa UI (kripto E2EE & transport, chat/outbox/backup/nearby/call, klien HTTP `reqwest`/`rustls`, Realtime Phoenix WebSocket, penyimpanan SQLite terenkripsi AES-GCM).
- `seru24-app/`: antarmuka Slint (`ui/*.slint`), controller UI + bridge JNI (`src/platform.rs`), serta entry point `android_main`.
- `android/`: host Android Gradle (AGP `9.2.1`, Java 17, R8 minify & shrink resources, Firebase Cloud Messaging, Google Play Services Nearby, `org.jitsi:webrtc`, Android Keystore, FileProvider).

## Uji di desktop (Windows)

```powershell
cd mobile-rust
cargo fmt --check
cargo clippy --all-targets -- -D warnings
cargo test
cargo run -p seru24-app
```

## Build & uji di Android (`emulator` & `arm64`)

```powershell
cd mobile-rust
.\build.ps1 -Emulator   # x86_64 emulator -> seru24-rust-<versi>-emulator.apk (tanpa naikkan versi)
.\build.ps1             # arm64-v8a rilis -> seru24-rust-<versi>.apk (tanda tangan keystore rilis)
.\release_apk.ps1       # build & unggah seru24-rust.apk (kanal 'android_rust_apk' mulai versi 2) ke Drive
.\release_apk.ps1 -Bump # naikkan versi (2 -> 3, dst.), build, lalu unggah ke Drive

$sdk = "$env:LOCALAPPDATA\Android\Sdk"
& "$sdk\platform-tools\adb.exe" install -r .\seru24-rust-2-emulator.apk
& "$sdk\platform-tools\adb.exe" shell am start -n id.seru24.chat.rust/.Seru24Activity
```

## Ukur RAM

Setelah daftar chat terbuka dan idle 30 detik (ulang 3 kali, ambil median):

```powershell
& "$sdk\platform-tools\adb.exe" shell dumpsys meminfo id.seru24.chat.rust | Select-String "TOTAL PSS|Native Heap|Java Heap|Graphics"
& "$sdk\platform-tools\adb.exe" shell dumpsys meminfo id.seru24.chat | Select-String "TOTAL PSS|Native Heap|Java Heap|Graphics"
```

Uji HP asli `arm64-v8a` (bila perangkat USB/wireless debugging tersambung):

```powershell
& "$sdk\platform-tools\adb.exe" install -r .\seru24-rust-2.apk
```
