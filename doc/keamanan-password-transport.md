# Keamanan Password dan Transport (seru24)

Dua lapisan yang melindungi data saat daftar/login, di atas TLS:

1. **Password tidak pernah dikirim** — browser menurunkan dua kunci dari password; server hanya menerima salah satunya.
2. **Payload browser ↔ server Nuxt dienkripsi** — pola sama dengan gaspro (ECDHE + HKDF + AES-256-GCM), sehingga isi permintaan tidak terbaca walau TLS disadap (proxy perusahaan, ekstensi browser, log perantara).

Kode: `web/shared/crypto.ts`, `web/shared/transport.ts`, `web/server/utils/transport.ts`, `web/app/utils/transport.ts`, `web/app/utils/session.ts`.

## 1. Satu password untuk login dan kunci chat

```
password (hanya di kepala pengguna dan memori browser)
   │
   │ scrypt(password, auth_salt, N=2^15, r=8, p=1) -> master 32 byte        RFC 7914
   │
   ├─ HKDF-SHA256(master, info="seru24/v1/auth")    -> auth_secret           RFC 5869
   │     dikirim ke server, dipakai sebagai "password" Supabase Auth (disimpan bcrypt oleh Supabase)
   │
   └─ HKDF-SHA256(master, info="seru24/v1/keywrap") -> wrap_key
         tidak pernah keluar browser; mengunci backup kunci privat chat (AES-256-GCM)
```

| Nilai | Di mana | Rahasia? |
|---|---|---|
| password | memori browser saat diketik | ya, tidak pernah dikirim |
| `auth_salt` (16 byte acak per akun) | `seru24.profiles.auth_salt` | tidak |
| `auth_secret` | dikirim ke server, disimpan Supabase sebagai hash bcrypt | ya |
| `wrap_key` | memori browser, dihapus setelah dipakai | ya, tidak pernah dikirim |
| kunci privat chat | IndexedDB (dibungkus kunci WebCrypto non-extractable) + backup terenkripsi `wrap_key` di `seru24.key_backups` | ya |

Kenapa aman: server (dan admin database) hanya melihat `auth_secret`. HKDF dan scrypt satu arah, jadi dari `auth_secret` tidak bisa dihitung `wrap_key` maupun password. Isi pesan tetap end-to-end.

Kenapa salt acak per akun, bukan bagian email (mis. 2 huruf depan + password + 2 huruf belakang email): login boleh memakai username, sehingga browser tidak selalu tahu email; memakai potongan email berarti server harus membocorkan sebagian email kepada siapa saja yang mengetik username. Salt acak 16 byte juga lebih kuat (unik dan tidak bisa ditebak).

### Alur

**Daftar**
1. Browser membuat `auth_salt` acak, menurunkan `auth_secret` + `wrap_key`.
2. Kirim (terenkripsi transport) `email, username, display_name, auth_secret, auth_salt`.
3. Server membuat akun Supabase dengan password = `auth_secret`; trigger menyimpan `auth_salt` ke profil.
4. Browser membuat pasangan kunci chat, membungkus kunci privat dengan `wrap_key`, menyimpan backup ke server.

**Login** (email atau username)
1. `POST /api/auth/prelogin {identifier}` → `{salt}`. Akun tak terdaftar mendapat salt palsu yang tetap (HKDF dari kunci server + identifier), jadi tidak bisa dipakai menebak akun (OWASP ASVS V2.2).
2. Browser menurunkan `auth_secret` + `wrap_key` dari password dan salt.
3. `POST /api/auth/login {identifier, auth_secret}`; server mencari email lalu `signInWithPassword`.
4. Bila kunci chat belum ada di perangkat: unduh backup, buka dengan `wrap_key`.

**Ganti password** (belum dibuat): browser membuka backup dengan `wrap_key` lama, membungkus ulang dengan `wrap_key` baru, membuat `auth_salt` baru, lalu memperbarui password Supabase ke `auth_secret` baru dalam satu alur.

**Lupa password**: akun bisa direset lewat email, tetapi pesan lama tidak bisa dibuka (server memang tidak pernah bisa). Dijelaskan di halaman daftar.

### Konsekuensi

- Aturan password (panjang minimal, dsb.) dicek di browser, karena Supabase hanya menerima `auth_secret` yang panjang dan acak. Minimal panjang diatur `NUXT_PUBLIC_PASSWORD_MIN_LENGTH` (bawaan 12, OWASP ASVS V2.1.1).
- Fitur "leaked password protection" Supabase tidak berlaku pada password asli.
- Akun yang dibuat sebelum skema ini tidak bisa login (password tersimpan dengan cara lama) dan harus didaftarkan ulang.

## 2. Enkripsi payload browser ↔ server

Diterapkan pada semua `POST /api/auth/*` (`prelogin`, `register`, `login`, `refresh`, `logout`). Body polos ditolak.

```
Server: kunci X25519 jangka panjang (NUXT_TRANSPORT_PRIVATE_KEY), publik di GET /api/crypto/public-key
Browser per permintaan:
  efemeral = X25519 keygen
  Z        = X25519(efemeral_privat, server_publik)
  nonce    = 12 byte acak
  key_req  = HKDF-SHA256(Z, salt=nonce, info="seru24-http-enc:req:v1")
  key_res  = HKDF-SHA256(Z, salt=nonce, info="seru24-http-enc:res:v1")
  body     = "<key_id>.<efemeral_publik b64url>.<nonce||AES-256-GCM(key_req, AAD=key_id, isi)||tag b64url>"
  isi      = {"request_id": uuid, "timestamp": detik, "payload": {...}}
Jawaban:   "<nonce||AES-256-GCM(key_res, {"request_id", "payload"})||tag b64url>"
```

| Kontrol | Penjelasan |
|---|---|
| Kerahasiaan | kunci efemeral per permintaan; penyadap tidak bisa membaca isi walau mencatat semua lalu lintas |
| Integritas | tag GCM; isi diubah = ditolak 400 |
| Jawaban terikat permintaan | `request_id` dicek di browser; jawaban permintaan lain ditolak |
| Anti replay | `timestamp` ±60 detik dan `request_id` sekali pakai (cache per instance server) |
| Rotasi kunci | `key_id` = 16 hex pertama sha256(kunci publik); kunci diganti → browser ambil ulang kunci publik sekali |
| Log | penolakan envelope dicatat `system_logs` dengan alasan singkat, tanpa isi payload |

Sama dengan gaspro (`EcdheKemEnvelope`, `Hkdf`, `DecryptRequestBodyMiddleware`), berbeda pada: X25519 menggantikan P-256 (satu library `@noble` untuk web dan mobile), AAD = `key_id`.

Batasan:
- Cache anti-replay ada di memori per instance Vercel; jendela 60 detik membatasi sisanya. Untuk jaminan penuh, simpan `request_id` di database/Redis.
- Melindungi dari penyadapan jaringan dan perantara, tetapi tidak dari skrip jahat yang berjalan di halaman itu sendiri (dicegah CSP).
- Panggilan data chat ke Supabase (RPC) tidak melewati lapisan ini; isinya sudah ciphertext E2EE, metadata dilindungi TLS.

## Variabel lingkungan

| Variabel | Sisi | Keterangan |
|---|---|---|
| `NUXT_TRANSPORT_PRIVATE_KEY` | server | kunci privat X25519 base64 (32 byte); ganti = rotasi kunci transport |
| `NUXT_PUBLIC_PASSWORD_MIN_LENGTH` | publik | minimal panjang password di browser (bawaan 12) |
| `NUXT_AUTH_SKIP_EMAIL_CONFIRM` | server | `true` = daftar tanpa verifikasi email (masa uji) |

Referensi: OWASP ASVS V2.1, V2.2, V2.4 (penyimpanan kredensial), V3.4, V6.2, V6.4, V9.1; RFC 5869, RFC 7748, RFC 7914; NIST SP 800-38D.
