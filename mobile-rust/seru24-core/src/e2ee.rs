//! Enkripsi/dekripsi pesan E2EE di atas primitif `crypto` (`web/shared/e2ee-core.ts`).

use std::collections::HashMap;

use serde::{Deserialize, Serialize};
use thiserror::Error;
use zeroize::Zeroizing;

use crate::chat::CacheableMsg;
use crate::crypto::{
    as_key_array, decrypt_message, derive_conversation_key, encrypt_message, from_base64,
    public_key_from_secret, random_id, safety_code, to_base64, CryptoError, MessageContext,
    MessageKind, PartyKey, SecretKeyring, KEY_BYTES, MAX_TEXT_LENGTH,
};
use crate::file::{parse_file_body, FileMessageBody};

#[derive(Debug, Error)]
pub enum E2eeError {
    #[error("Kunci tidak tersedia")]
    KeyUnavailable,
    #[error("Maksimal {MAX_TEXT_LENGTH} karakter")]
    TextTooLong,
    #[error("kripto gagal: {0}")]
    Crypto(#[from] CryptoError),
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ChatMessage {
    pub id: String,
    pub conversation_id: String,
    pub sender_id: Option<String>,
    pub seq: i64,
    pub client_msg_id: String,
    pub kind: MessageKind,
    pub ciphertext: Option<String>,
    pub nonce: Option<String>,
    pub sender_key_version: u32,
    pub recipient_key_version: u32,
    pub reply_to: Option<String>,
    pub created_at: String,
    #[serde(default)]
    pub offline_sent_at: Option<String>,
    pub edited_at: Option<String>,
    pub deleted_at: Option<String>,
    pub expires_at: Option<String>,
}

impl CacheableMsg for ChatMessage {
    fn client_msg_id(&self) -> &str {
        &self.client_msg_id
    }
    fn seq(&self) -> i64 {
        self.seq
    }
    fn deleted_at(&self) -> Option<&str> {
        self.deleted_at.as_deref()
    }
    fn edited_at(&self) -> Option<&str> {
        self.edited_at.as_deref()
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PublicKeyRow {
    pub key_version: u32,
    pub public_key: String,
    pub revoked: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PeerKeyCheck {
    Match,
    Mismatch,
    Unknown,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PeerKeyStatus {
    Missing,
    Ok { code: String },
    Changed { code: String },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SealedMessageParams {
    pub p_conversation_id: String,
    pub p_client_msg_id: String,
    pub p_kind: MessageKind,
    pub p_ciphertext: String,
    pub p_nonce: String,
    pub p_sender_key_version: u32,
    pub p_recipient_key_version: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub p_attachment_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub p_reply_to: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct RawMessageBody {
    #[serde(default)]
    pub t: Option<serde_json::Value>,
    #[serde(default)]
    pub f: Option<serde_json::Value>,
}

#[derive(Serialize)]
struct TextBody<'a> {
    t: &'a str,
}

#[derive(Serialize)]
struct FileBody<'a> {
    f: &'a FileMessageBody,
}

#[derive(Debug, Clone, Copy)]
pub struct SealTarget<'a> {
    pub conversation_id: &'a str,
    pub me: PartyKey<'a>,
    pub peer_id: &'a str,
    pub peer_key: &'a PublicKeyRow,
}

/// Cache kunci publik dan kunci turunan percakapan di memori (di-zeroize saat reset).
#[derive(Default)]
pub struct E2eeEngine {
    public_keys: HashMap<String, Vec<PublicKeyRow>>,
    conversation_keys: HashMap<String, Zeroizing<[u8; KEY_BYTES]>>,
}

impl E2eeEngine {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn reset(&mut self) {
        self.public_keys.clear();
        self.conversation_keys.clear();
    }

    pub fn cache_public_keys(&mut self, user_id: &str, rows: Vec<PublicKeyRow>) {
        self.public_keys.insert(user_id.to_string(), rows);
    }

    pub fn cached_public_keys(&self, user_id: &str) -> Option<&[PublicKeyRow]> {
        self.public_keys.get(user_id).map(|v| v.as_slice())
    }

    pub fn latest_active_key(&self, user_id: &str) -> Option<&PublicKeyRow> {
        self.public_keys
            .get(user_id)
            .and_then(|rows| rows.iter().rev().find(|r| !r.revoked))
    }

    pub fn find_key(&self, user_id: &str, version: u32) -> Option<&PublicKeyRow> {
        self.public_keys
            .get(user_id)?
            .iter()
            .find(|r| r.key_version == version)
    }

    pub fn derive_and_cache_key(
        &mut self,
        conversation_id: &str,
        me: PartyKey<'_>,
        peer: PartyKey<'_>,
        keyring: &SecretKeyring,
        override_key: Option<&PublicKeyRow>,
    ) -> Result<[u8; KEY_BYTES], E2eeError> {
        let override_pk = override_key.map(|k| k.public_key.as_str()).unwrap_or("");
        let cache_key = format!(
            "{conversation_id}|{}|{}|{override_pk}",
            me.key_version, peer.key_version
        );
        if let Some(existing) = self.conversation_keys.get(&cache_key) {
            return Ok(**existing);
        }

        let my_secret = keyring
            .get(&me.key_version.to_string())
            .ok_or(E2eeError::KeyUnavailable)?;
        let peer_pk_b64 = match override_key {
            Some(k) if k.key_version == peer.key_version => &k.public_key,
            _ => {
                &self
                    .find_key(peer.user_id, peer.key_version)
                    .ok_or(E2eeError::KeyUnavailable)?
                    .public_key
            }
        };
        let peer_pk_bytes = Zeroizing::new(from_base64(peer_pk_b64)?);
        let peer_pk = as_key_array(&peer_pk_bytes)?;

        let derived = derive_conversation_key(my_secret, &peer_pk, conversation_id, me, peer)?;
        let raw = *derived;
        self.conversation_keys.insert(cache_key, derived);
        Ok(raw)
    }

    fn seal_body<T: serde::Serialize>(
        &mut self,
        target: SealTarget<'_>,
        keyring: &SecretKeyring,
        kind: MessageKind,
        body: &T,
        meta: (Option<String>, Option<String>, Option<String>),
    ) -> Result<SealedMessageParams, E2eeError> {
        let (attachment_id, reply_to, client_msg_id) = meta;
        let cid = match client_msg_id {
            Some(id) => id,
            None => random_id()?,
        };
        let key = self.derive_and_cache_key(
            target.conversation_id,
            target.me,
            PartyKey {
                user_id: target.peer_id,
                key_version: target.peer_key.key_version,
            },
            keyring,
            Some(target.peer_key),
        )?;
        let sealed = encrypt_message(
            &key,
            body,
            &MessageContext {
                conversation_id: target.conversation_id,
                sender_id: target.me.user_id,
                client_msg_id: &cid,
                kind,
            },
        )?;
        Ok(SealedMessageParams {
            p_conversation_id: target.conversation_id.to_string(),
            p_client_msg_id: cid,
            p_kind: kind,
            p_ciphertext: sealed.ciphertext,
            p_nonce: sealed.nonce,
            p_sender_key_version: target.me.key_version,
            p_recipient_key_version: target.peer_key.key_version,
            p_attachment_id: attachment_id,
            p_reply_to: reply_to,
        })
    }

    pub fn seal_text(
        &mut self,
        target: SealTarget<'_>,
        keyring: &SecretKeyring,
        text: &str,
        reply_to: Option<String>,
        client_msg_id: Option<String>,
    ) -> Result<SealedMessageParams, E2eeError> {
        if text.chars().count() > MAX_TEXT_LENGTH {
            return Err(E2eeError::TextTooLong);
        }
        self.seal_body(
            target,
            keyring,
            MessageKind::Text,
            &TextBody { t: text },
            (None, reply_to, client_msg_id),
        )
    }

    pub fn seal_file(
        &mut self,
        target: SealTarget<'_>,
        keyring: &SecretKeyring,
        file: &FileMessageBody,
        reply_to: Option<String>,
    ) -> Result<SealedMessageParams, E2eeError> {
        self.seal_body(
            target,
            keyring,
            MessageKind::File,
            &FileBody { f: file },
            (Some(file.id.clone()), reply_to, None),
        )
    }

    pub fn open_body(
        &mut self,
        message: &ChatMessage,
        my_id: &str,
        peer_id: &str,
        keyring: &SecretKeyring,
        override_key: Option<&PublicKeyRow>,
    ) -> Option<RawMessageBody> {
        if message.deleted_at.is_some() {
            return None;
        }
        let (ciphertext, nonce) = (message.ciphertext.as_ref()?, message.nonce.as_ref()?);
        let mine = message.sender_id.as_deref() == Some(my_id);
        let my_ver = if mine {
            message.sender_key_version
        } else {
            message.recipient_key_version
        };
        let peer_ver = if mine {
            message.recipient_key_version
        } else {
            message.sender_key_version
        };
        let key = self
            .derive_and_cache_key(
                &message.conversation_id,
                PartyKey {
                    user_id: my_id,
                    key_version: my_ver,
                },
                PartyKey {
                    user_id: peer_id,
                    key_version: peer_ver,
                },
                keyring,
                override_key,
            )
            .ok()?;

        let sender = message.sender_id.as_deref().unwrap_or("");
        decrypt_message::<RawMessageBody>(
            &key,
            &crate::crypto::EncryptedPayload {
                ciphertext: ciphertext.clone(),
                nonce: nonce.clone(),
            },
            &MessageContext {
                conversation_id: &message.conversation_id,
                sender_id: sender,
                client_msg_id: &message.client_msg_id,
                kind: message.kind,
            },
        )
        .ok()
    }

    pub fn decrypt_text(
        &mut self,
        message: &ChatMessage,
        my_id: &str,
        peer_id: &str,
        keyring: &SecretKeyring,
        override_key: Option<&PublicKeyRow>,
    ) -> Option<String> {
        let body = self.open_body(message, my_id, peer_id, keyring, override_key)?;
        if let Some(serde_json::Value::String(text)) = body.t {
            return Some(text.chars().take(MAX_TEXT_LENGTH).collect());
        }
        let file = body.f.as_ref().and_then(parse_file_body);
        file.map(|f| format!("📎 {}", f.name))
    }

    pub fn decrypt_file(
        &mut self,
        message: &ChatMessage,
        my_id: &str,
        peer_id: &str,
        keyring: &SecretKeyring,
    ) -> Option<FileMessageBody> {
        if message.kind != MessageKind::File {
            return None;
        }
        let body = self.open_body(message, my_id, peer_id, keyring, None)?;
        body.f.as_ref().and_then(parse_file_body)
    }

    pub fn verify_peer_tofu(
        my_secret: &[u8; KEY_BYTES],
        peer_public_b64: &str,
        known_b64: Option<&str>,
    ) -> PeerKeyStatus {
        let Ok(peer_bytes) = from_base64(peer_public_b64) else {
            return PeerKeyStatus::Missing;
        };
        let Ok(peer_pk) = as_key_array(&peer_bytes) else {
            return PeerKeyStatus::Missing;
        };
        let my_pk = public_key_from_secret(my_secret);
        let code = safety_code(&my_pk, &peer_pk);
        match known_b64 {
            Some(known) if known != peer_public_b64 => PeerKeyStatus::Changed { code },
            _ => PeerKeyStatus::Ok { code },
        }
    }

    pub fn check_claimed_key(&self, user_id: &str, claimed: &PublicKeyRow) -> PeerKeyCheck {
        let Some(rows) = self.cached_public_keys(user_id) else {
            return PeerKeyCheck::Unknown;
        };
        let Some(known) = rows.iter().find(|r| r.key_version == claimed.key_version) else {
            return PeerKeyCheck::Unknown;
        };
        if known.public_key == claimed.public_key && !known.revoked {
            PeerKeyCheck::Match
        } else {
            PeerKeyCheck::Mismatch
        }
    }

    pub fn my_public_key_b64(keyring: &SecretKeyring, key_version: u32) -> Option<String> {
        let secret = keyring.get(&key_version.to_string())?;
        Some(to_base64(&public_key_from_secret(secret)))
    }
}
