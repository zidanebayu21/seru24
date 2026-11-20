//! Enkripsi payload HTTP klien <-> server Nuxt di atas TLS (`web/shared/transport.ts`).
//! Pola EcdheKemEnvelope: X25519 efemeral + HKDF-SHA256 (salt=nonce) + AES-256-GCM (AAD=key_id).
//! OWASP ASVS V9.1, V6.2.

use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use thiserror::Error;
use zeroize::Zeroizing;

use crate::crypto::{
    as_key_array, from_base64_url, generate_key_pair, hkdf_sha256_expand, open_raw, random_bytes,
    random_id, seal_with_nonce, to_base64_url, x25519_shared_secret, CryptoError, KeyPair,
    KEY_BYTES, NONCE_BYTES, TAG_BYTES,
};

const INFO_REQUEST: &str = "seru24-http-enc:req:v1";
const INFO_RESPONSE: &str = "seru24-http-enc:res:v1";
const KEY_ID_HEX: usize = 16;

#[derive(Debug, Error)]
pub enum TransportError {
    #[error("kripto gagal: {0}")]
    Crypto(#[from] CryptoError),
    #[error("format amplop transport tidak valid: {0}")]
    Malformed(&'static str),
    #[error("key_id tidak cocok")]
    UnknownKeyId,
    #[error("request_id pada jawaban tidak cocok")]
    RequestIdMismatch,
    #[error("JSON tidak valid: {0}")]
    Json(#[from] serde_json::Error),
}

pub struct SealedRequest {
    pub compact: String,
    pub key_res: Zeroizing<[u8; KEY_BYTES]>,
    pub request_id: String,
}

#[derive(Debug, Clone)]
pub struct OpenedRequest {
    pub payload: serde_json::Value,
    pub key_res: Zeroizing<[u8; KEY_BYTES]>,
    pub request_id: String,
    pub timestamp: i64,
}

#[derive(Serialize)]
struct RequestEnvelope<'a, T: Serialize> {
    request_id: &'a str,
    timestamp: i64,
    payload: &'a T,
}

#[derive(Deserialize)]
struct OpenedRequestInner {
    request_id: Option<String>,
    timestamp: Option<i64>,
    payload: Option<serde_json::Value>,
}

#[derive(Deserialize)]
struct ResponseInner<T> {
    request_id: String,
    payload: T,
}

#[derive(Serialize)]
struct ResponseOut<'a, T: Serialize> {
    request_id: &'a str,
    payload: &'a T,
}

pub fn transport_key_id(server_public_key: &[u8; KEY_BYTES]) -> String {
    let hex_digest = hex::encode(Sha256::digest(server_public_key));
    hex_digest[..KEY_ID_HEX].to_string()
}

type SessionKeys = (Zeroizing<[u8; KEY_BYTES]>, Zeroizing<[u8; KEY_BYTES]>);

fn derive_keys(
    shared: &[u8; KEY_BYTES],
    nonce: &[u8; NONCE_BYTES],
) -> Result<SessionKeys, TransportError> {
    let key_req = hkdf_sha256_expand(shared, Some(nonce), INFO_REQUEST.as_bytes())?;
    let key_res = hkdf_sha256_expand(shared, Some(nonce), INFO_RESPONSE.as_bytes())?;
    Ok((key_req, key_res))
}

fn split_body(blob: &[u8]) -> Result<(&[u8], &[u8]), TransportError> {
    if blob.len() < NONCE_BYTES + TAG_BYTES {
        return Err(TransportError::Malformed("bad body segment"));
    }
    Ok(blob.split_at(NONCE_BYTES))
}

/// Membungkus payload untuk server dengan kunci efemeral, nonce, dan `request_id` acak.
pub fn seal_request<T: Serialize>(
    server_public_key: &[u8; KEY_BYTES],
    key_id: &str,
    payload: &T,
    timestamp_secs: i64,
) -> Result<SealedRequest, TransportError> {
    let ephemeral = generate_key_pair()?;
    let nonce = random_bytes::<NONCE_BYTES>()?;
    let request_id = random_id()?;
    seal_request_with_params(
        server_public_key,
        key_id,
        payload,
        timestamp_secs,
        &ephemeral,
        &nonce,
        &request_id,
    )
}

/// Varian deterministik untuk uji vektor silang.
pub fn seal_request_with_params<T: Serialize>(
    server_public_key: &[u8; KEY_BYTES],
    key_id: &str,
    payload: &T,
    timestamp_secs: i64,
    ephemeral: &KeyPair,
    nonce: &[u8; NONCE_BYTES],
    request_id: &str,
) -> Result<SealedRequest, TransportError> {
    let shared = x25519_shared_secret(&ephemeral.secret_key, server_public_key);
    let (key_req, key_res) = derive_keys(&shared, nonce)?;
    let inner = Zeroizing::new(serde_json::to_vec(&RequestEnvelope {
        request_id,
        timestamp: timestamp_secs,
        payload,
    })?);
    let sealed = seal_with_nonce(&key_req, nonce, &inner, key_id.as_bytes())?;
    let mut combined = Vec::with_capacity(NONCE_BYTES + sealed.len());
    combined.extend_from_slice(nonce);
    combined.extend_from_slice(&sealed);

    let compact = format!(
        "{}.{}.{}",
        key_id,
        to_base64_url(&ephemeral.public_key),
        to_base64_url(&combined)
    );
    Ok(SealedRequest {
        compact,
        key_res,
        request_id: request_id.to_string(),
    })
}

/// Membuka jawaban terenkripsi dari server dan memastikan `request_id` sesuai permintaan.
pub fn open_response<T: DeserializeOwned>(
    raw: &str,
    key_res: &[u8; KEY_BYTES],
    request_id: &str,
) -> Result<T, TransportError> {
    let bytes = from_base64_url(raw.trim())?;
    let (nonce, sealed) = split_body(&bytes)?;
    let plain = Zeroizing::new(open_raw(key_res, nonce, sealed, &[])?);
    let inner: ResponseInner<T> = serde_json::from_slice(&plain)?;
    if inner.request_id != request_id {
        return Err(TransportError::RequestIdMismatch);
    }
    Ok(inner.payload)
}

/// Membuka permintaan klien (dipakai untuk uji silang dua arah Rust <-> TypeScript).
pub fn open_request(
    compact: &str,
    server_secret_key: &[u8; KEY_BYTES],
    expected_key_id: &str,
) -> Result<OpenedRequest, TransportError> {
    let segments: Vec<&str> = compact.trim().split('.').collect();
    if segments.len() != 3 {
        return Err(TransportError::Malformed("malformed compact envelope"));
    }
    let (key_id, client_pub_b64, body_b64) = (segments[0], segments[1], segments[2]);
    if key_id != expected_key_id {
        return Err(TransportError::UnknownKeyId);
    }
    let client_pub = as_key_array(&from_base64_url(client_pub_b64)?)?;
    let body = from_base64_url(body_b64)?;
    let (nonce, sealed) = split_body(&body)?;
    let nonce_arr: [u8; NONCE_BYTES] = nonce
        .try_into()
        .map_err(|_| TransportError::Malformed("bad nonce length"))?;
    let shared = x25519_shared_secret(server_secret_key, &client_pub);
    let (key_req, key_res) = derive_keys(&shared, &nonce_arr)?;
    let plain = Zeroizing::new(open_raw(&key_req, nonce, sealed, key_id.as_bytes())?);
    let inner: OpenedRequestInner = serde_json::from_slice(&plain)?;
    let (Some(request_id), Some(timestamp), Some(payload)) =
        (inner.request_id, inner.timestamp, inner.payload)
    else {
        return Err(TransportError::Malformed("malformed inner plaintext"));
    };
    Ok(OpenedRequest {
        payload,
        key_res,
        request_id,
        timestamp,
    })
}

/// Membungkus jawaban dengan `key_res` milik permintaan (dipakai untuk uji silang).
pub fn seal_response<T: Serialize>(
    payload: &T,
    key_res: &[u8; KEY_BYTES],
    request_id: &str,
) -> Result<String, TransportError> {
    let nonce = random_bytes::<NONCE_BYTES>()?;
    let inner = Zeroizing::new(serde_json::to_vec(&ResponseOut {
        request_id,
        payload,
    })?);
    let sealed = seal_with_nonce(key_res, &nonce, &inner, &[])?;
    let mut combined = Vec::with_capacity(NONCE_BYTES + sealed.len());
    combined.extend_from_slice(&*nonce);
    combined.extend_from_slice(&sealed);
    Ok(to_base64_url(&combined))
}
