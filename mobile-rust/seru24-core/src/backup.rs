//! Cadangan riwayat chat lokal terenkripsi ke file teks (`web/shared/backup-core.ts`).

use std::collections::{BTreeMap, HashSet};

use serde::{Deserialize, Serialize};
use thiserror::Error;
use zeroize::Zeroizing;

use crate::chat::Conversation;
use crate::crypto::{
    from_base64, hkdf_sha256_expand, open_raw, random_bytes, seal_with_nonce, to_base64,
    CryptoError, SecretKeyring, KEY_BYTES, NONCE_BYTES,
};
use crate::e2ee::ChatMessage;

pub const BACKUP_FORMAT: &str = "seru24-backup";
pub const BACKUP_VERSION: u32 = 1;
pub const MAX_BACKUP_BYTES: usize = 40 * 1024 * 1024;
const BACKUP_INFO: &str = "seru24:backup:v1";

#[derive(Debug, Error)]
pub enum BackupError {
    #[error("File terlalu besar")]
    TooLarge,
    #[error("Bukan file cadangan seru24")]
    InvalidFormat,
    #[error("File cadangan ini milik akun lain")]
    WrongUser,
    #[error("Kunci chat belum siap")]
    KeyNotReady,
    #[error("File cadangan rusak atau tidak cocok dengan akun ini")]
    CorruptOrMismatch,
    #[error("Isi cadangan tidak valid")]
    InvalidBody,
    #[error("kripto gagal: {0}")]
    Crypto(#[from] CryptoError),
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupData {
    pub exported_at: String,
    pub conversations: Vec<Conversation>,
    pub messages: Vec<ChatMessage>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct BackupEnvelope {
    format: String,
    version: u32,
    user: String,
    n: String,
    c: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PartialBackupEnvelope {
    format: Option<serde_json::Value>,
    version: Option<serde_json::Value>,
    user: Option<serde_json::Value>,
    n: Option<serde_json::Value>,
    c: Option<serde_json::Value>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawBackupData {
    exported_at: Option<serde_json::Value>,
    conversations: Option<serde_json::Value>,
    messages: Option<serde_json::Value>,
}

fn aad(user_id: &str) -> Vec<u8> {
    format!("{BACKUP_FORMAT}:{BACKUP_VERSION}:{user_id}").into_bytes()
}

fn backup_key(
    keyring: &SecretKeyring,
    user_id: &str,
) -> Result<Zeroizing<[u8; KEY_BYTES]>, BackupError> {
    let mut versions: Vec<(&str, i64)> = keyring
        .keys()
        .filter_map(|k| k.parse::<i64>().ok().map(|n| (k.as_str(), n)))
        .collect();
    versions.sort_by_key(|(_, n)| *n);
    let secret = versions
        .first()
        .and_then(|(k, _)| keyring.get(*k))
        .ok_or(BackupError::KeyNotReady)?;
    Ok(hkdf_sha256_expand(
        &**secret,
        Some(user_id.as_bytes()),
        BACKUP_INFO.as_bytes(),
    )?)
}

pub fn seal_backup(
    keyring: &SecretKeyring,
    user_id: &str,
    data: &BackupData,
) -> Result<String, BackupError> {
    let key = backup_key(keyring, user_id)?;
    let nonce = random_bytes::<NONCE_BYTES>()?;
    let json = Zeroizing::new(serde_json::to_vec(data).map_err(|_| BackupError::InvalidBody)?);
    let cipher = seal_with_nonce(&key, &nonce, &json, &aad(user_id))?;
    let envelope = BackupEnvelope {
        format: BACKUP_FORMAT.to_string(),
        version: BACKUP_VERSION,
        user: user_id.to_string(),
        n: to_base64(&*nonce),
        c: to_base64(&cipher),
    };
    serde_json::to_string(&envelope).map_err(|_| BackupError::InvalidBody)
}

pub fn open_backup(
    keyring: &SecretKeyring,
    user_id: &str,
    text: &str,
) -> Result<BackupData, BackupError> {
    if text.len() > MAX_BACKUP_BYTES {
        return Err(BackupError::TooLarge);
    }
    let partial: PartialBackupEnvelope =
        serde_json::from_str(text).map_err(|_| BackupError::InvalidFormat)?;
    let format_ok = partial.format.as_ref().and_then(|v| v.as_str()) == Some(BACKUP_FORMAT);
    let version_ok =
        partial.version.as_ref().and_then(|v| v.as_u64()) == Some(BACKUP_VERSION as u64);
    let n = partial.n.as_ref().and_then(|v| v.as_str());
    let c = partial.c.as_ref().and_then(|v| v.as_str());
    let (Some(nonce_b64), Some(cipher_b64)) = (
        format_ok.then_some(n).flatten(),
        version_ok.then_some(c).flatten(),
    ) else {
        return Err(BackupError::InvalidFormat);
    };
    if partial.user.as_ref().and_then(|v| v.as_str()) != Some(user_id) {
        return Err(BackupError::WrongUser);
    }

    let key = backup_key(keyring, user_id)?;
    let nonce = from_base64(nonce_b64).map_err(|_| BackupError::CorruptOrMismatch)?;
    let cipher = from_base64(cipher_b64).map_err(|_| BackupError::CorruptOrMismatch)?;
    let plain = Zeroizing::new(
        open_raw(&key, &nonce, &cipher, &aad(user_id))
            .map_err(|_| BackupError::CorruptOrMismatch)?,
    );
    let raw: RawBackupData =
        serde_json::from_slice(&plain).map_err(|_| BackupError::CorruptOrMismatch)?;
    let convs_val = raw
        .conversations
        .as_ref()
        .and_then(|v| v.as_array())
        .ok_or(BackupError::InvalidBody)?;
    let msgs_val = raw
        .messages
        .as_ref()
        .and_then(|v| v.as_array())
        .ok_or(BackupError::InvalidBody)?;

    let conversations = convs_val
        .iter()
        .filter_map(|v| serde_json::from_value::<Conversation>(v.clone()).ok())
        .collect();
    let messages = msgs_val
        .iter()
        .filter_map(|v| serde_json::from_value::<ChatMessage>(v.clone()).ok())
        .collect();
    let exported_at = raw
        .exported_at
        .as_ref()
        .and_then(|v| v.as_str())
        .unwrap_or_default()
        .to_string();

    Ok(BackupData {
        exported_at,
        conversations,
        messages,
    })
}

pub fn merge_conversations(
    existing: &[Conversation],
    incoming: &[Conversation],
) -> Vec<Conversation> {
    let known: HashSet<&str> = existing.iter().map(|c| c.id.as_str()).collect();
    let mut merged = existing.to_vec();
    for c in incoming {
        if !known.contains(c.id.as_str()) {
            merged.push(c.clone());
        }
    }
    merged
}

pub fn group_messages_by_conversation(
    messages: &[ChatMessage],
) -> BTreeMap<String, Vec<ChatMessage>> {
    let mut groups: BTreeMap<String, Vec<ChatMessage>> = BTreeMap::new();
    for m in messages {
        groups
            .entry(m.conversation_id.clone())
            .or_default()
            .push(m.clone());
    }
    groups
}
