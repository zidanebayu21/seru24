//! Penyimpanan lokal SQLite terenkripsi AES-256-GCM (`mobile/src/lib/chatStorage.ts` & keystore KV).
//! OWASP ASVS V8.3: seluruh data sensitif (keyring, refresh token, cache pesan, outbox) dienkripsi sebelum ditulis.

use std::collections::HashSet;
use std::path::Path;
use std::sync::{Arc, Mutex};

use rusqlite::{params, Connection};
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use thiserror::Error;
use zeroize::Zeroizing;

use crate::chat::{Conversation, DecryptedMessageView};
use crate::crypto::{
    as_key_array, decode_keyring_json, encode_keyring_json, from_base64, open_payload,
    random_bytes, seal_payload, to_base64, CryptoError, EncryptedPayload, SecretKeyring, KEY_BYTES,
};
use crate::e2ee::{ChatMessage, PublicKeyRow};
use crate::preview::Preview;

#[derive(Debug, Error)]
pub enum StorageError {
    #[error("SQLite gagal: {0}")]
    Sqlite(#[from] rusqlite::Error),
    #[error("kripto penyimpanan gagal: {0}")]
    Crypto(#[from] CryptoError),
    #[error("JSON tidak valid: {0}")]
    Json(#[from] serde_json::Error),
    #[error("IO gagal: {0}")]
    Io(#[from] std::io::Error),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LocalChatStorageStats {
    pub conversations: usize,
    pub messages: usize,
    pub size_bytes: Option<u64>,
}

#[derive(Debug, Clone)]
pub struct LoadedConversationState {
    pub messages: Vec<ChatMessage>,
    pub deleted_ids: HashSet<String>,
    pub cleared_up_to_seq: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SavedMe {
    pub id: String,
    pub username: String,
    pub display_name: String,
    pub has_keys: bool,
    pub key_version: Option<u32>,
}

/// Vault SQLite terenkripsi untuk sesi, kunci E2EE, cache chat, pin, dan antrean outbox.
#[derive(Clone)]
pub struct LocalVault {
    conn: Arc<Mutex<Connection>>,
    master_key: Zeroizing<[u8; KEY_BYTES]>,
    db_path: Option<std::path::PathBuf>,
}

impl LocalVault {
    pub fn open_with_master_key(
        db_path: &Path,
        master_key: [u8; KEY_BYTES],
    ) -> Result<Self, StorageError> {
        if let Some(parent) = db_path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let conn = Connection::open(db_path)?;
        let vault = Self {
            conn: Arc::new(Mutex::new(conn)),
            master_key: Zeroizing::new(master_key),
            db_path: Some(db_path.to_path_buf()),
        };
        vault.init_schema()?;
        Ok(vault)
    }

    /// Untuk CLI desktop: membaca/membuat file kunci 32 byte di sebelah berkas `.sqlite`.
    pub fn open_desktop(db_path: &Path) -> Result<Self, StorageError> {
        if let Some(parent) = db_path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let key_path = db_path.with_extension("master.key");
        let master_key = if key_path.exists() {
            let b64 = Zeroizing::new(std::fs::read_to_string(&key_path)?);
            let raw = Zeroizing::new(from_base64(b64.trim())?);
            as_key_array(&raw)?
        } else {
            let fresh = random_bytes::<KEY_BYTES>()?;
            std::fs::write(&key_path, to_base64(&*fresh))?;
            *fresh
        };
        Self::open_with_master_key(db_path, master_key)
    }

    pub fn open_in_memory() -> Result<Self, StorageError> {
        let fresh = random_bytes::<KEY_BYTES>()?;
        let conn = Connection::open_in_memory()?;
        let vault = Self {
            conn: Arc::new(Mutex::new(conn)),
            master_key: fresh,
            db_path: None,
        };
        vault.init_schema()?;
        Ok(vault)
    }

    fn init_schema(&self) -> Result<(), StorageError> {
        let conn = self.conn.lock().expect("vault mutex");
        conn.execute_batch(
            "
            PRAGMA journal_mode = WAL;
            CREATE TABLE IF NOT EXISTS kv_secrets (
                k TEXT PRIMARY KEY,
                sealed TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS conversations (
                user_id TEXT NOT NULL,
                conv_id TEXT NOT NULL,
                sealed TEXT NOT NULL,
                PRIMARY KEY (user_id, conv_id)
            );
            CREATE TABLE IF NOT EXISTS messages (
                user_id TEXT NOT NULL,
                conv_id TEXT NOT NULL,
                client_msg_id TEXT NOT NULL,
                seq INTEGER NOT NULL,
                sealed TEXT NOT NULL,
                PRIMARY KEY (user_id, conv_id, client_msg_id)
            );
            CREATE INDEX IF NOT EXISTS idx_messages_conv_seq
                ON messages(user_id, conv_id, seq);
            CREATE TABLE IF NOT EXISTS deleted_ids (
                user_id TEXT NOT NULL,
                conv_id TEXT NOT NULL,
                client_msg_id TEXT NOT NULL,
                PRIMARY KEY (user_id, conv_id, client_msg_id)
            );
            CREATE TABLE IF NOT EXISTS cleared_seq (
                user_id TEXT NOT NULL,
                conv_id TEXT NOT NULL,
                up_to_seq INTEGER NOT NULL,
                PRIMARY KEY (user_id, conv_id)
            );
            ",
        )?;
        Ok(())
    }

    fn seal_str(&self, plaintext: &[u8], aad: &str) -> Result<String, StorageError> {
        let payload = seal_payload(&self.master_key, plaintext, aad.as_bytes())?;
        Ok(serde_json::to_string(&payload)?)
    }

    fn open_str(&self, raw: &str, aad: &str) -> Result<Vec<u8>, StorageError> {
        let payload: EncryptedPayload = serde_json::from_str(raw)?;
        Ok(open_payload(&self.master_key, &payload, aad.as_bytes())?)
    }

    pub fn get_secret(&self, key: &str) -> Result<Option<Zeroizing<String>>, StorageError> {
        let conn = self.conn.lock().expect("vault mutex");
        let mut stmt = conn.prepare("SELECT sealed FROM kv_secrets WHERE k = ?1")?;
        let mut rows = stmt.query(params![key])?;
        let Some(row) = rows.next()? else {
            return Ok(None);
        };
        let sealed: String = row.get(0)?;
        drop(rows);
        drop(stmt);
        drop(conn);
        let plain = Zeroizing::new(self.open_str(&sealed, key)?);
        let s = String::from_utf8(plain.to_vec()).map_err(CryptoError::Utf8)?;
        Ok(Some(Zeroizing::new(s)))
    }

    pub fn set_secret(&self, key: &str, value: &str) -> Result<(), StorageError> {
        let sealed = self.seal_str(value.as_bytes(), key)?;
        let conn = self.conn.lock().expect("vault mutex");
        conn.execute(
            "INSERT INTO kv_secrets(k, sealed) VALUES(?1, ?2)
             ON CONFLICT(k) DO UPDATE SET sealed = excluded.sealed",
            params![key, sealed],
        )?;
        Ok(())
    }

    pub fn remove_secret(&self, key: &str) -> Result<(), StorageError> {
        let conn = self.conn.lock().expect("vault mutex");
        conn.execute("DELETE FROM kv_secrets WHERE k = ?1", params![key])?;
        Ok(())
    }

    pub fn get_json<T: DeserializeOwned>(&self, key: &str) -> Result<Option<T>, StorageError> {
        match self.get_secret(key)? {
            Some(raw) => Ok(Some(serde_json::from_str(&raw)?)),
            None => Ok(None),
        }
    }

    pub fn set_json<T: Serialize>(&self, key: &str, value: &T) -> Result<(), StorageError> {
        let raw = Zeroizing::new(serde_json::to_string(value)?);
        self.set_secret(key, &raw)
    }

    pub fn load_keyring(&self, user_id: &str) -> Result<Option<SecretKeyring>, StorageError> {
        let Some(raw) = self.get_secret(&format!("seru24.keyring.{user_id}"))? else {
            return Ok(None);
        };
        Ok(Some(decode_keyring_json(&raw)?))
    }

    pub fn save_keyring(&self, user_id: &str, ring: &SecretKeyring) -> Result<(), StorageError> {
        let json = encode_keyring_json(ring)?;
        self.set_secret(&format!("seru24.keyring.{user_id}"), &json)
    }

    pub fn remove_keyring(&self, user_id: &str) -> Result<(), StorageError> {
        self.remove_secret(&format!("seru24.keyring.{user_id}"))
    }

    pub fn load_pubkeys(&self, user_id: &str) -> Result<Option<Vec<PublicKeyRow>>, StorageError> {
        self.get_json(&format!("seru24.pubkeys.{user_id}"))
    }

    pub fn save_pubkeys(&self, user_id: &str, rows: &[PublicKeyRow]) -> Result<(), StorageError> {
        self.set_json(&format!("seru24.pubkeys.{user_id}"), &rows)
    }

    pub fn load_tofu(&self, my_id: &str, peer_id: &str) -> Result<Option<String>, StorageError> {
        Ok(self
            .get_secret(&format!("seru24:tofu:{my_id}:{peer_id}"))?
            .map(|s| s.to_string()))
    }

    pub fn save_tofu(&self, my_id: &str, peer_id: &str, pub_b64: &str) -> Result<(), StorageError> {
        self.set_secret(&format!("seru24:tofu:{my_id}:{peer_id}"), pub_b64)
    }

    pub fn save_conversations(
        &self,
        user_id: &str,
        list: &[Conversation],
    ) -> Result<(), StorageError> {
        let mut prepared = Vec::with_capacity(list.len());
        for conv in list {
            let aad = format!("conv:{user_id}:{}", conv.id);
            let json = Zeroizing::new(serde_json::to_vec(conv)?);
            prepared.push((conv.id.as_str(), self.seal_str(&json, &aad)?));
        }
        let mut conn = self.conn.lock().expect("vault mutex");
        let tx = conn.transaction()?;
        tx.execute(
            "DELETE FROM conversations WHERE user_id = ?1",
            params![user_id],
        )?;
        {
            let mut stmt = tx.prepare(
                "INSERT INTO conversations(user_id, conv_id, sealed) VALUES(?1, ?2, ?3)",
            )?;
            for (conv_id, sealed) in prepared {
                stmt.execute(params![user_id, conv_id, sealed])?;
            }
        }
        tx.commit()?;
        Ok(())
    }

    pub fn load_conversations(&self, user_id: &str) -> Result<Vec<Conversation>, StorageError> {
        let rows_raw: Vec<(String, String)> = {
            let conn = self.conn.lock().expect("vault mutex");
            let mut stmt =
                conn.prepare("SELECT conv_id, sealed FROM conversations WHERE user_id = ?1")?;
            let mapped = stmt.query_map(params![user_id], |r| Ok((r.get(0)?, r.get(1)?)))?;
            mapped.collect::<Result<Vec<_>, _>>()?
        };

        let mut list = Vec::new();
        for (conv_id, sealed) in rows_raw {
            let aad = format!("conv:{user_id}:{conv_id}");
            if let Ok(plain) = self.open_str(&sealed, &aad) {
                if let Ok(conv) = serde_json::from_slice::<Conversation>(&plain) {
                    list.push(conv);
                }
            }
        }
        list.sort_by(|a, b| {
            b.pinned
                .cmp(&a.pinned)
                .then_with(|| b.last_message_at.cmp(&a.last_message_at))
        });
        Ok(list)
    }

    pub fn save_messages(
        &self,
        user_id: &str,
        conversation_id: &str,
        messages: &[ChatMessage],
    ) -> Result<(), StorageError> {
        if messages.is_empty() {
            return Ok(());
        }
        let aad = format!("msg:{user_id}:{conversation_id}");
        let mut prepared = Vec::with_capacity(messages.len());
        for m in messages {
            let json = Zeroizing::new(serde_json::to_vec(m)?);
            prepared.push((m.client_msg_id.as_str(), m.seq, self.seal_str(&json, &aad)?));
        }
        let mut conn = self.conn.lock().expect("vault mutex");
        let tx = conn.transaction()?;
        {
            let mut stmt = tx.prepare(
                "INSERT INTO messages(user_id, conv_id, client_msg_id, seq, sealed)
                 VALUES(?1, ?2, ?3, ?4, ?5)
                 ON CONFLICT(user_id, conv_id, client_msg_id)
                 DO UPDATE SET seq = excluded.seq, sealed = excluded.sealed",
            )?;
            for (cid, seq, sealed) in prepared {
                stmt.execute(params![user_id, conversation_id, cid, seq, sealed])?;
            }
        }
        tx.commit()?;
        Ok(())
    }

    pub fn load_conversation_state(
        &self,
        user_id: &str,
        conversation_id: &str,
    ) -> Result<LoadedConversationState, StorageError> {
        let (msg_sealed, del_ids, cleared): (Vec<String>, HashSet<String>, i64) = {
            let conn = self.conn.lock().expect("vault mutex");
            let mut stmt = conn.prepare(
                "SELECT sealed FROM messages WHERE user_id = ?1 AND conv_id = ?2 ORDER BY seq ASC",
            )?;
            let msgs = stmt
                .query_map(params![user_id, conversation_id], |r| r.get(0))?
                .collect::<Result<Vec<String>, _>>()?;

            let mut dstmt = conn.prepare(
                "SELECT client_msg_id FROM deleted_ids WHERE user_id = ?1 AND conv_id = ?2",
            )?;
            let dels = dstmt
                .query_map(params![user_id, conversation_id], |r| r.get(0))?
                .collect::<Result<HashSet<String>, _>>()?;

            let mut cstmt = conn
                .prepare("SELECT up_to_seq FROM cleared_seq WHERE user_id = ?1 AND conv_id = ?2")?;
            let cleared: i64 = cstmt
                .query_row(params![user_id, conversation_id], |r| r.get(0))
                .unwrap_or(0);
            (msgs, dels, cleared)
        };

        let aad = format!("msg:{user_id}:{conversation_id}");
        let mut messages = Vec::new();
        for s in msg_sealed {
            if let Ok(plain) = self.open_str(&s, &aad) {
                if let Ok(msg) = serde_json::from_slice::<ChatMessage>(&plain) {
                    if !del_ids.contains(&msg.client_msg_id) && msg.seq > cleared {
                        messages.push(msg);
                    }
                }
            }
        }

        Ok(LoadedConversationState {
            messages,
            deleted_ids: del_ids,
            cleared_up_to_seq: cleared,
        })
    }

    pub fn mark_local_deleted(
        &self,
        user_id: &str,
        conversation_id: &str,
        client_msg_id: &str,
    ) -> Result<(), StorageError> {
        let conn = self.conn.lock().expect("vault mutex");
        conn.execute(
            "INSERT OR IGNORE INTO deleted_ids(user_id, conv_id, client_msg_id) VALUES(?1, ?2, ?3)",
            params![user_id, conversation_id, client_msg_id],
        )?;
        conn.execute(
            "DELETE FROM messages WHERE user_id = ?1 AND conv_id = ?2 AND client_msg_id = ?3",
            params![user_id, conversation_id, client_msg_id],
        )?;
        Ok(())
    }

    pub fn clear_conversation(
        &self,
        user_id: &str,
        conversation_id: &str,
        up_to_seq: i64,
    ) -> Result<(), StorageError> {
        let mut conn = self.conn.lock().expect("vault mutex");
        let tx = conn.transaction()?;
        tx.execute(
            "DELETE FROM messages WHERE user_id = ?1 AND conv_id = ?2",
            params![user_id, conversation_id],
        )?;
        tx.execute(
            "DELETE FROM deleted_ids WHERE user_id = ?1 AND conv_id = ?2",
            params![user_id, conversation_id],
        )?;
        tx.execute(
            "INSERT INTO cleared_seq(user_id, conv_id, up_to_seq) VALUES(?1, ?2, ?3)
             ON CONFLICT(user_id, conv_id) DO UPDATE SET up_to_seq = MAX(cleared_seq.up_to_seq, excluded.up_to_seq)",
            params![user_id, conversation_id, up_to_seq],
        )?;
        tx.commit()?;
        Ok(())
    }

    pub fn clear_all_chats(&self, user_id: &str) -> Result<(), StorageError> {
        let mut conn = self.conn.lock().expect("vault mutex");
        let tx = conn.transaction()?;
        tx.execute(
            "DELETE FROM conversations WHERE user_id = ?1",
            params![user_id],
        )?;
        tx.execute("DELETE FROM messages WHERE user_id = ?1", params![user_id])?;
        tx.execute(
            "DELETE FROM deleted_ids WHERE user_id = ?1",
            params![user_id],
        )?;
        tx.execute(
            "DELETE FROM cleared_seq WHERE user_id = ?1",
            params![user_id],
        )?;
        tx.commit()?;
        Ok(())
    }

    pub fn stats(&self, user_id: &str) -> Result<LocalChatStorageStats, StorageError> {
        let conn = self.conn.lock().expect("vault mutex");
        let conversations: i64 = conn.query_row(
            "SELECT COUNT(*) FROM conversations WHERE user_id = ?1",
            params![user_id],
            |r| r.get(0),
        )?;
        let messages: i64 = conn.query_row(
            "SELECT COUNT(*) FROM messages WHERE user_id = ?1",
            params![user_id],
            |r| r.get(0),
        )?;
        let size_bytes = self
            .db_path
            .as_ref()
            .and_then(|p| std::fs::metadata(p).ok().map(|m| m.len()));
        Ok(LocalChatStorageStats {
            conversations: conversations.max(0) as usize,
            messages: messages.max(0) as usize,
            size_bytes,
        })
    }

    pub fn save_preview(
        &self,
        user_id: &str,
        conversation_id: &str,
        preview: &Preview,
    ) -> Result<(), StorageError> {
        self.set_json(&format!("preview.{user_id}.{conversation_id}"), preview)
    }

    pub fn load_preview(
        &self,
        user_id: &str,
        conversation_id: &str,
    ) -> Result<Option<Preview>, StorageError> {
        self.get_json(&format!("preview.{user_id}.{conversation_id}"))
    }

    pub fn save_nearby_received(
        &self,
        conversation_id: &str,
        items: &[DecryptedMessageView],
    ) -> Result<(), StorageError> {
        self.set_json(&format!("nearby.rx.{conversation_id}"), &items)
    }

    pub fn load_nearby_received(
        &self,
        conversation_id: &str,
    ) -> Result<Vec<DecryptedMessageView>, StorageError> {
        Ok(self
            .get_json(&format!("nearby.rx.{conversation_id}"))?
            .unwrap_or_default())
    }
}
