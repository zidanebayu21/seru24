# Progres migrasi Rust + Slint

Diperbarui oleh agent setiap selesai satu butir. Acuan: `../migraterust.md`.

## Fase 0 (Gerbang 0)
- [x] Toolchain (target Android, cargo-apk2, cargo-ndk, sccache)
- [x] Prototipe `seru24-app` (daftar chat, layar chat 500 pesan, bubble revisi pink, tema)
- [x] APK emulator x86_64: 6,90 MB / 7.238.104 B (RN 1.25 emulator: 17,3 MB)
- [x] Jalan di emulator: daftar chat, buka chat, scroll 500 pesan, keyboard, emoji, seleksi teks
- [x] RAM: Rust 3 sampel median (48.234 KB / ~47,1 MB idle, 56.222 KB / ~54,9 MB setelah buka chat 500 pesan) vs RN 1.25 (99.714 KB / ~97,4 MB idle, 108.533 KB / ~106,0 MB setelah buka chat)
- [x] Uji tema Terang/Gelap/Coklat dan cek logcat (0 FATAL/crash; `Palette.color-scheme` disinkronkan agar `LineEdit` Material ikut mode gelap)
- [x] APK arm64: `seru24-rust-2.apk` 6,63 MB / 6.947.291 B (vs RN 1.25 `mobile/seru24-25.apk` 16,12 MB / 16.898.781 B); uji HP asli tertunda karena hanya emulator yang terhubung ADB
- [x] Emoji bendera/ZWJ/modifier kulit: diperbaiki dengan mendaftarkan `"Noto Color Emoji"` + `"Noto Color Emoji Flags"` (`/system/fonts/NotoColorEmojiFlags.ttf`) via `slint::fontique_012` (0 byte tambahan ke APK); terverifikasi tampil berwarna penuh pada `🇮🇩 👍🏽 👍🏿 👨‍👩‍👧 👩‍💻 ❤️‍🔥`
- [x] Pilihan lisensi Slint dari pemilik: **GPLv3** (`GPL-3.0-only` — aplikasi komunitas sumber terbuka & non-komersial, tercantum di [LICENSE](LICENSE) dan `Cargo.toml`)
- [x] Fase 0 selesai; lanjut Fase 1~5 sesuai instruksi pemilik

## Fase 1-5
- [x] **Fase 1 (`seru24-core` kripto & domain)**: port `crypto.ts`, `transport.ts`, `backup.ts`, `e2ee.ts`, `chat.ts`, `file.ts`, `nearby.ts`, `pin.ts`, `preview.ts`, `schedule.ts`, `search.ts`, `call_core.ts`, `call_quality.ts`, `app_release.ts`; **Gerbang 1 LULUS** (uji vektor silang 2 arah TS <-> Rust lewat Node + `core_behavior` lolos & clippy `-D warnings` bersih).
- [x] **Fase 2 (`seru24-core` jaringan & CLI)**: `api.rs` (`secureFetch` + Supabase PostgREST RPC), `realtime.rs` (Phoenix WebSocket), `storage.rs` (SQLite terenkripsi AES-GCM), `outbox.rs` (antrean offline + fallback `PGRST202`), tes `wiremock`, dan `examples/cli.rs`; **Gerbang 2 LULUS** (login akun uji live, daftar percakapan, & dekripsi pesan E2EE terverifikasi).
- [x] Fase 3: UI Slint (`seru24-app` terhubung penuh ke `seru24-core`: Auth, ChatList dengan switch Dekat/Standby & tombol Cari solid, popup menu Akun/Profil/Tema melayang, layar Chat dengan popup menu ⋮, bubble audio/dokumen/revisi/balasan, composer pill, Nearby, & CallBar; verifikasi paritas visual di `emulator-5554`)
- [x] Fase 4: Fitur platform Android native via JNI + Gradle (`Seru24Application`, `Seru24Activity` extends `NativeActivity`, `Seru24Keystore` AES-GCM, `Seru24Files` terenkripsi chunk + pemutar audio, `Seru24Notifications` + `Seru24FcmService`, `Seru24Nearby` `P2P_CLUSTER`, `Seru24Updater` SHA-256 + `FileProvider`; `.gitignore` mengecualikan `target/`, `android/.gradle/`, `jniLibs/`, `build/`, `*.apk`, `*.idsig`, & secrets)
- [x] Fase 5: Telepon suara 1-1 (`org.jitsi:webrtc:155.0.1` + `Seru24CallWebRtc` + `CallStateMachine`), verifikasi RPC Supabase read-only (`cargo run -p seru24-core --example cli -- check-db`), uji desktop (`cargo fmt --check`, `cargo clippy --all-targets -- -D warnings`, `cargo test` 8/8 lulus), build APK final:
  - `seru24-rust-2.apk` (`arm64-v8a` rilis bertanda tangan, tanpa renderer ganda FemtoVG, `--pack-dyn-relocs=android+relr`, `--icf=all`, `force-unwind-tables=no`): **14,87 MB** (`15.594.634` B — `libseru24_app.so` `8,50 MiB` + `libjingle_peerconnection_so.so` `5,73 MiB`, lebih kecil dari RN 1.25 `16,12 MB` / `16.898.781` B)
  - `seru24-rust-2-emulator.apk` (`x86_64` rilis): **16,07 MB** (lebih kecil dari RN 1.25 emulator `17,3 MB`)
  - RAM build Gradle penuh di `emulator-5554`: idle ChatList median **59.827 KB (~58,4 MB)** (3 sampel: `52.017` / `59.839` / `59.827` KB), layar chat terbuka **61.092 KB (~59,7 MB)** (vs RN 1.25 `99.714 KB` / `108.533 KB`), `logcat` 0 error/FATAL
- [ ] Uji perangkat fisik `arm64-v8a` via USB (termasuk audio telepon WebRTC real, Nearby Bluetooth/Wi-Fi fisik antar 2 HP, & IME OEM) — tertunda karena baru `emulator-5554` yang tersambung
