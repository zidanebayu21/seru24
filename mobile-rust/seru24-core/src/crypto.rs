//! Primitif kriptografi E2EE dan penurunan kunci password untuk `seru24`.
//!
//! Referensi protokol (`web/shared/crypto.ts`, `doc/keamanan-password-transport.md`):
//! - Pertukaran kunci: X25519 (RFC 7748)
//! - Penurunan kunci: HKDF-SHA256 (RFC 5869) & scrypt N=2^15, r=8, p=1 (RFC 7914)
//! - Enkripsi terotentikasi: AES-256-GCM, nonce 12 byte, tag 16 byte (NIST SP 800-38D)
//! - OWASP ASVS V6: hanya CSPRNG OS (`getrandom`), kunci rahasia di-zeroize setelah dipakai.

use std::collections::BTreeMap;

use aes_gcm::aead::{Aead, KeyInit, Payload};
use aes_gcm::{Aes256Gcm, Nonce};
use base64::engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD};
use base64::Engine as _;
use hkdf::Hkdf;
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use thiserror::Error;
use unicode_normalization::UnicodeNormalization;
use x25519_dalek::{PublicKey, StaticSecret};
use zeroize::{Zeroize, Zeroizing};

pub const NONCE_BYTES: usize = 12;
pub const KEY_BYTES: usize = 32;
pub const TAG_BYTES: usize = 16;
pub const MAX_TEXT_LENGTH: usize = 4000;
pub const AUTH_SALT_BYTES: usize = 16;

pub const SCRYPT_N: u32 = 1 << 15;
pub const SCRYPT_LOG_N: u8 = 15;
pub const SCRYPT_R: u32 = 8;
pub const SCRYPT_P: u32 = 1;

const INFO_MESSAGE: &str = "seru24/v1/msg";
const INFO_AUTH: &str = "seru24/v1/auth";
const INFO_KEYWRAP: &str = "seru24/v1/keywrap";
const AAD_BACKUP: &str = "seru24/v1/backup";

#[derive(Debug, Error)]
pub enum CryptoError {
    #[error("panjang kunci harus {KEY_BYTES} byte, diterima {0}")]
    InvalidKeyLength(usize),
    #[error("panjang nonce harus {NONCE_BYTES} byte, diterima {0}")]
    InvalidNonceLength(usize),
    #[error("input base64 tidak valid: {0}")]
    Base64(#[from] base64::DecodeError),
    #[error("gagal menghasilkan angka acak OS")]
    Rng,
    #[error("parameter scrypt tidak valid")]
    ScryptParams,
    #[error("enkripsi atau dekripsi AEAD gagal")]
    Aead,
    #[error("format JSON pesan/backup tidak valid: {0}")]
    Json(#[from] serde_json::Error),
    #[error("hasil dekripsi bukan UTF-8 valid")]
    Utf8(#[from] std::string::FromUtf8Error),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum MessageKind {
    Text,
    Image,
    File,
}

impl MessageKind {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Text => "text",
            Self::Image => "image",
            Self::File => "file",
        }
    }
}

#[derive(Clone)]
pub struct KeyPair {
    pub secret_key: Zeroizing<[u8; KEY_BYTES]>,
    pub public_key: [u8; KEY_BYTES],
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct EncryptedPayload {
    pub ciphertext: String,
    pub nonce: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MessageContext<'a> {
    pub conversation_id: &'a str,
    pub sender_id: &'a str,
    pub client_msg_id: &'a str,
    pub kind: MessageKind,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PartyKey<'a> {
    pub user_id: &'a str,
    pub key_version: u32,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct KdfParams {
    pub salt: String,
    #[serde(rename = "N")]
    pub n: u32,
    pub r: u32,
    pub p: u32,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct KeyBackup {
    pub encrypted_keys: String,
    pub nonce: String,
    pub kdf: String,
    pub kdf_params: KdfParams,
}

/// Kunci privat per versi (mis. `"1" -> 32 byte`), di-zeroize otomatis saat drop.
pub type SecretKeyring = BTreeMap<String, Zeroizing<[u8; KEY_BYTES]>>;

pub struct PasswordSecrets {
    /// Base64url 43 karakter tanpa padding, dikirim ke server sebagai password Supabase Auth.
    pub auth_secret: Zeroizing<String>,
    /// Kunci pembungkus backup kunci privat; tidak pernah keluar perangkat.
    pub wrap_key: Zeroizing<[u8; KEY_BYTES]>,
}

pub fn random_bytes<const N: usize>() -> Result<Zeroizing<[u8; N]>, CryptoError> {
    let mut buf = Zeroizing::new([0u8; N]);
    getrandom::getrandom(&mut *buf).map_err(|_| CryptoError::Rng)?;
    Ok(buf)
}

pub fn to_base64(bytes: &[u8]) -> String {
    STANDARD.encode(bytes)
}

pub fn from_base64(value: &str) -> Result<Vec<u8>, CryptoError> {
    Ok(STANDARD.decode(value)?)
}

/// Base64url tanpa padding (RFC 4648 bagian 5).
pub fn to_base64_url(bytes: &[u8]) -> String {
    URL_SAFE_NO_PAD.encode(bytes)
}

pub fn from_base64_url(value: &str) -> Result<Vec<u8>, CryptoError> {
    Ok(URL_SAFE_NO_PAD.decode(value.trim_end_matches('='))?)
}

pub fn as_key_array(bytes: &[u8]) -> Result<[u8; KEY_BYTES], CryptoError> {
    bytes
        .try_into()
        .map_err(|_| CryptoError::InvalidKeyLength(bytes.len()))
}

pub fn generate_key_pair() -> Result<KeyPair, CryptoError> {
    let mut raw = random_bytes::<KEY_BYTES>()?;
    let secret = StaticSecret::from(*raw);
    let public = PublicKey::from(&secret);
    let secret_bytes = Zeroizing::new(secret.to_bytes());
    raw.zeroize();
    Ok(KeyPair {
        secret_key: secret_bytes,
        public_key: public.to_bytes(),
    })
}

pub fn public_key_from_secret(secret_key: &[u8; KEY_BYTES]) -> [u8; KEY_BYTES] {
    let secret = StaticSecret::from(*secret_key);
    PublicKey::from(&secret).to_bytes()
}

pub fn x25519_shared_secret(
    my_secret_key: &[u8; KEY_BYTES],
    peer_public_key: &[u8; KEY_BYTES],
) -> Zeroizing<[u8; KEY_BYTES]> {
    let secret = StaticSecret::from(*my_secret_key);
    let peer = PublicKey::from(*peer_public_key);
    let shared = secret.diffie_hellman(&peer);
    Zeroizing::new(shared.to_bytes())
}

pub fn hkdf_sha256_expand(
    ikm: &[u8],
    salt: Option<&[u8]>,
    info: &[u8],
) -> Result<Zeroizing<[u8; KEY_BYTES]>, CryptoError> {
    let hk = Hkdf::<Sha256>::new(salt, ikm);
    let mut out = Zeroizing::new([0u8; KEY_BYTES]);
    hk.expand(info, &mut *out).map_err(|_| CryptoError::Aead)?;
    Ok(out)
}

/// Menurunkan kunci simetris percakapan identik di kedua pihak (urutan `userId:keyVersion` kanonik).
pub fn derive_conversation_key(
    my_secret_key: &[u8; KEY_BYTES],
    peer_public_key: &[u8; KEY_BYTES],
    conversation_id: &str,
    me: PartyKey<'_>,
    peer: PartyKey<'_>,
) -> Result<Zeroizing<[u8; KEY_BYTES]>, CryptoError> {
    let shared = x25519_shared_secret(my_secret_key, peer_public_key);
    let a = format!("{}:{}", me.user_id, me.key_version);
    let b = format!("{}:{}", peer.user_id, peer.key_version);
    let (first, second) = if a <= b { (&a, &b) } else { (&b, &a) };
    let info = format!("{INFO_MESSAGE}|{first}|{second}");
    hkdf_sha256_expand(&*shared, Some(conversation_id.as_bytes()), info.as_bytes())
}

pub fn message_aad(ctx: &MessageContext<'_>) -> Vec<u8> {
    format!(
        "{}|{}|{}|{}",
        ctx.conversation_id,
        ctx.sender_id,
        ctx.client_msg_id,
        ctx.kind.as_str()
    )
    .into_bytes()
}

pub fn seal_with_nonce(
    key: &[u8; KEY_BYTES],
    nonce: &[u8; NONCE_BYTES],
    plaintext: &[u8],
    aad: &[u8],
) -> Result<Vec<u8>, CryptoError> {
    let cipher = Aes256Gcm::new_from_slice(key).map_err(|_| CryptoError::Aead)?;
    cipher
        .encrypt(
            Nonce::from_slice(nonce),
            Payload {
                msg: plaintext,
                aad,
            },
        )
        .map_err(|_| CryptoError::Aead)
}

pub fn open_raw(
    key: &[u8; KEY_BYTES],
    nonce: &[u8],
    ciphertext: &[u8],
    aad: &[u8],
) -> Result<Vec<u8>, CryptoError> {
    if nonce.len() != NONCE_BYTES {
        return Err(CryptoError::InvalidNonceLength(nonce.len()));
    }
    let cipher = Aes256Gcm::new_from_slice(key).map_err(|_| CryptoError::Aead)?;
    cipher
        .decrypt(
            Nonce::from_slice(nonce),
            Payload {
                msg: ciphertext,
                aad,
            },
        )
        .map_err(|_| CryptoError::Aead)
}

pub fn seal_payload(
    key: &[u8; KEY_BYTES],
    plaintext: &[u8],
    aad: &[u8],
) -> Result<EncryptedPayload, CryptoError> {
    let nonce = random_bytes::<NONCE_BYTES>()?;
    let ciphertext = seal_with_nonce(key, &nonce, plaintext, aad)?;
    Ok(EncryptedPayload {
        ciphertext: to_base64(&ciphertext),
        nonce: to_base64(&*nonce),
    })
}

pub fn open_payload(
    key: &[u8; KEY_BYTES],
    payload: &EncryptedPayload,
    aad: &[u8],
) -> Result<Vec<u8>, CryptoError> {
    let nonce = from_base64(&payload.nonce)?;
    let ciphertext = from_base64(&payload.ciphertext)?;
    open_raw(key, &nonce, &ciphertext, aad)
}

pub fn encrypt_message<T: Serialize>(
    key: &[u8; KEY_BYTES],
    body: &T,
    ctx: &MessageContext<'_>,
) -> Result<EncryptedPayload, CryptoError> {
    let json = Zeroizing::new(serde_json::to_vec(body)?);
    seal_payload(key, &json, &message_aad(ctx))
}

pub fn decrypt_message<T: DeserializeOwned>(
    key: &[u8; KEY_BYTES],
    payload: &EncryptedPayload,
    ctx: &MessageContext<'_>,
) -> Result<T, CryptoError> {
    let plain = Zeroizing::new(open_payload(key, payload, &message_aad(ctx))?);
    Ok(serde_json::from_slice(&plain)?)
}

pub fn new_auth_salt() -> Result<String, CryptoError> {
    let bytes = random_bytes::<AUTH_SALT_BYTES>()?;
    Ok(to_base64(&*bytes))
}

/// Menurunkan `auth_secret` (untuk Supabase Auth) dan `wrap_key` (hanya lokal) dari password akun.
pub fn derive_password_secrets(
    password: &str,
    auth_salt: &str,
) -> Result<PasswordSecrets, CryptoError> {
    let normalized = Zeroizing::new(password.nfkc().collect::<String>());
    let salt = from_base64(auth_salt)?;
    let params = scrypt::Params::new(SCRYPT_LOG_N, SCRYPT_R, SCRYPT_P, KEY_BYTES)
        .map_err(|_| CryptoError::ScryptParams)?;
    let mut master = Zeroizing::new([0u8; KEY_BYTES]);
    scrypt::scrypt(normalized.as_bytes(), &salt, &params, &mut *master)
        .map_err(|_| CryptoError::ScryptParams)?;

    let auth_bytes = hkdf_sha256_expand(&*master, None, INFO_AUTH.as_bytes())?;
    let wrap_key = hkdf_sha256_expand(&*master, None, INFO_KEYWRAP.as_bytes())?;
    Ok(PasswordSecrets {
        auth_secret: Zeroizing::new(to_base64_url(&*auth_bytes)),
        wrap_key,
    })
}

pub fn create_key_backup(
    keyring: &SecretKeyring,
    wrap_key: &[u8; KEY_BYTES],
    user_id: &str,
    auth_salt: &str,
) -> Result<KeyBackup, CryptoError> {
    let mut plain: BTreeMap<String, String> = BTreeMap::new();
    for (ver, key) in keyring {
        plain.insert(ver.clone(), to_base64(&**key));
    }
    let json = Zeroizing::new(serde_json::to_vec(&plain)?);
    let aad = format!("{AAD_BACKUP}|{user_id}");
    let sealed = seal_payload(wrap_key, &json, aad.as_bytes())?;
    Ok(KeyBackup {
        encrypted_keys: sealed.ciphertext,
        nonce: sealed.nonce,
        kdf: "scrypt".to_string(),
        kdf_params: KdfParams {
            salt: auth_salt.to_string(),
            n: SCRYPT_N,
            r: SCRYPT_R,
            p: SCRYPT_P,
        },
    })
}

pub fn open_key_backup(
    backup: &KeyBackup,
    wrap_key: &[u8; KEY_BYTES],
    user_id: &str,
) -> Result<SecretKeyring, CryptoError> {
    let aad = format!("{AAD_BACKUP}|{user_id}");
    let plain = Zeroizing::new(open_payload(
        wrap_key,
        &EncryptedPayload {
            ciphertext: backup.encrypted_keys.clone(),
            nonce: backup.nonce.clone(),
        },
        aad.as_bytes(),
    )?);
    let encoded: BTreeMap<String, String> = serde_json::from_slice(&plain)?;
    let mut out = SecretKeyring::new();
    for (ver, b64) in encoded {
        let raw = Zeroizing::new(from_base64(&b64)?);
        let arr = as_key_array(&raw)?;
        out.insert(ver, Zeroizing::new(arr));
    }
    Ok(out)
}

/// Sidik jari 40 hex (kelompok 5) untuk verifikasi lisan pasangan kunci publik.
pub fn safety_code(public_key_a: &[u8; KEY_BYTES], public_key_b: &[u8; KEY_BYTES]) -> String {
    let hex_a = hex::encode(public_key_a);
    let hex_b = hex::encode(public_key_b);
    let (first, second) = if hex_a <= hex_b {
        (public_key_a, public_key_b)
    } else {
        (public_key_b, public_key_a)
    };
    let mut hasher = Sha256::new();
    hasher.update(first);
    hasher.update(second);
    let digest = hex::encode(hasher.finalize());
    let prefix = &digest[..40];
    prefix
        .as_bytes()
        .chunks(5)
        .map(|c| std::str::from_utf8(c).unwrap_or_default())
        .collect::<Vec<_>>()
        .join(" ")
}

/// UUID v4 dari CSPRNG OS (RFC 4122).
pub fn random_id() -> Result<String, CryptoError> {
    let mut b = random_bytes::<16>()?;
    b[6] = (b[6] & 0x0f) | 0x40;
    b[8] = (b[8] & 0x3f) | 0x80;
    let h = hex::encode(*b);
    Ok(format!(
        "{}-{}-{}-{}-{}",
        &h[0..8],
        &h[8..12],
        &h[12..16],
        &h[16..20],
        &h[20..32]
    ))
}

/// Mengodekan `SecretKeyring` ke JSON base64 untuk penyimpanan aman.
pub fn encode_keyring_json(keyring: &SecretKeyring) -> Result<Zeroizing<String>, CryptoError> {
    let map: BTreeMap<&String, String> = keyring
        .iter()
        .map(|(ver, key)| (ver, to_base64(&**key)))
        .collect();
    Ok(Zeroizing::new(serde_json::to_string(&map)?))
}

/// Membaca `SecretKeyring` dari JSON base64.
pub fn decode_keyring_json(raw: &str) -> Result<SecretKeyring, CryptoError> {
    let map: BTreeMap<String, String> = serde_json::from_str(raw)?;
    let mut ring = SecretKeyring::new();
    for (ver, b64) in map {
        let bytes = Zeroizing::new(from_base64(&b64)?);
        let arr = as_key_array(&bytes)?;
        ring.insert(ver, Zeroizing::new(arr));
    }
    Ok(ring)
}
