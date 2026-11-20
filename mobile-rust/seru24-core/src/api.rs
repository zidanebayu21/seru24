//! Klien jaringan Nuxt (`secureFetch` envelope terenkripsi) & Supabase PostgREST RPC
//! (`web/shared/session-core.ts`, `account-core.ts`, `secure-fetch-core.ts`, `mobile/src/lib/core.ts`).

use std::collections::BTreeMap;
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use reqwest::Client;
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use thiserror::Error;
use tokio::sync::Mutex;
use zeroize::Zeroizing;

use crate::chat::{Conversation, FoundUser, ListConversationsOptions};
use crate::crypto::{
    as_key_array, create_key_backup, derive_password_secrets, from_base64_url, generate_key_pair,
    new_auth_salt, open_key_backup, random_bytes, to_base64, KeyBackup, SecretKeyring, KEY_BYTES,
};
use crate::e2ee::{ChatMessage, PublicKeyRow};
use crate::env::AppEnv;
use crate::realtime::parse_incoming_frame;
use crate::schedule::{ScheduleResult, ScheduledRow};
use crate::storage::{LocalVault, SavedMe, StorageError};
use crate::transport::{open_response, seal_request, TransportError};

const ENVELOPE_REJECTED: &str = "Permintaan terenkripsi tidak valid";
const REFRESH_MARGIN_MS: i64 = 30_000;
const VISITOR_SECRET_KEY: &str = "seru24.visitor";
const REFRESH_SECRET_KEY: &str = "seru24.refresh";
const LAST_ME_SECRET_KEY: &str = "seru24.last_me";

#[derive(Debug, Error)]
pub enum ApiError {
    #[error("konfigurasi server belum diisi (SUPABASE_URL / ANON_KEY)")]
    Unconfigured,
    #[error("kesalahan jaringan: {0}")]
    Network(#[from] reqwest::Error),
    #[error("HTTP {status}: {message}")]
    Http {
        status: u16,
        message: String,
        log_id: Option<String>,
    },
    #[error("RPC gagal ({status}): {message}")]
    Rpc {
        status: u16,
        code: Option<String>,
        message: String,
    },
    #[error("transport gagal: {0}")]
    Transport(#[from] TransportError),
    #[error("penyimpanan lokal gagal: {0}")]
    Storage(#[from] StorageError),
    #[error("sesi tidak valid atau berakhir")]
    Unauthorized,
    #[error("kripto gagal: {0}")]
    Crypto(#[from] crate::crypto::CryptoError),
    #[error("jawaban server tidak sesuai: {0}")]
    InvalidResponseDetail(&'static str),
    #[error("jawaban server tidak sesuai")]
    InvalidResponse,
}

impl ApiError {
    pub fn is_network_like(&self) -> bool {
        match self {
            Self::Network(_) => true,
            Self::Http { status, .. } => *status >= 500 || *status == 0,
            Self::Rpc { status, .. } => *status >= 500 || *status == 0,
            _ => false,
        }
    }

    /// Pesan aman untuk pengguna (`web/shared/secure-fetch-core.ts: errorMessage`, OWASP ASVS V7.4.1).
    pub fn user_message(&self, fallback: &str) -> String {
        match self {
            Self::Http {
                status,
                message,
                log_id,
            } => {
                let msg = if !message.is_empty() {
                    message.as_str()
                } else if *status == 429 {
                    "Terlalu banyak percobaan. Tunggu sebentar."
                } else {
                    fallback
                };
                match log_id {
                    Some(id) => format!("{msg} (kode log: {id})"),
                    None => msg.to_string(),
                }
            }
            Self::Network(_) => "Koneksi ke server gagal. Periksa jaringan.".to_string(),
            _ => fallback.to_string(),
        }
    }
}

#[derive(Debug, Clone, Deserialize)]
struct ErrorBody {
    #[serde(rename = "statusMessage")]
    status_message: Option<String>,
    data: Option<ErrorBodyData>,
}

#[derive(Debug, Clone, Deserialize)]
struct ErrorBodyData {
    log_id: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
struct PostgrestErrorBody {
    code: Option<String>,
    message: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
struct ServerPublicKeyResp {
    key_id: String,
    public_key: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SessionResponse {
    pub access_token: String,
    pub expires_at: i64,
    pub user_id: String,
    pub refresh_token: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
struct PreloginResp {
    salt: String,
}

#[derive(Debug, Clone, Deserialize)]
struct RegisterResp {
    status: String,
    access_token: Option<String>,
    expires_at: Option<i64>,
    user_id: Option<String>,
    refresh_token: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Me {
    pub id: String,
    pub username: String,
    pub display_name: String,
    pub has_keys: bool,
    pub key_version: Option<u32>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AccountStatus {
    Unknown,
    Locked,
    Ready,
    Offline,
}

pub struct KeyMaterial {
    pub wrap_key: Zeroizing<[u8; KEY_BYTES]>,
    pub salt: String,
}

pub enum RegisterOutcome {
    Active(KeyMaterial),
    VerifyEmail,
}

#[derive(Clone)]
struct CachedServerKey {
    key_id: String,
    public_key: [u8; KEY_BYTES],
}

#[derive(Default)]
struct SessionState {
    access_token: Option<Zeroizing<String>>,
    expires_at_ms: i64,
    user_id: Option<String>,
    last_refresh_offline: bool,
}

#[derive(Clone)]
pub struct SecureHttp {
    http: Client,
    api_base_url: String,
    server_key: Arc<Mutex<Option<CachedServerKey>>>,
}

fn now_secs() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

fn now_millis() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

impl SecureHttp {
    pub fn new(api_base_url: impl Into<String>) -> Result<Self, ApiError> {
        let http = Client::builder().timeout(Duration::from_secs(20)).build()?;
        Ok(Self {
            http,
            api_base_url: api_base_url.into().trim_end_matches('/').to_string(),
            server_key: Arc::new(Mutex::new(None)),
        })
    }

    pub fn base_url(&self) -> &str {
        &self.api_base_url
    }

    async fn load_server_key(&self) -> Result<CachedServerKey, ApiError> {
        {
            let guard = self.server_key.lock().await;
            if let Some(ref key) = *guard {
                return Ok(key.clone());
            }
        }
        let url = format!("{}/api/crypto/public-key", self.api_base_url);
        let resp = self.http.get(&url).send().await?;
        let status = resp.status().as_u16();
        if status >= 400 {
            return Err(ApiError::Http {
                status,
                message: String::new(),
                log_id: None,
            });
        }
        let body: ServerPublicKeyResp = resp.json().await?;
        let raw = from_base64_url(&body.public_key).map_err(TransportError::from)?;
        let pk = as_key_array(&raw).map_err(TransportError::from)?;
        let key = CachedServerKey {
            key_id: body.key_id,
            public_key: pk,
        };
        let mut guard = self.server_key.lock().await;
        *guard = Some(key.clone());
        Ok(key)
    }

    pub async fn secure_post<P: Serialize + Sync, R: DeserializeOwned>(
        &self,
        path: &str,
        payload: &P,
    ) -> Result<R, ApiError> {
        self.secure_post_inner(path, payload, true).await
    }

    fn secure_post_inner<'a, P: Serialize + Sync, R: DeserializeOwned + 'a>(
        &'a self,
        path: &'a str,
        payload: &'a P,
        allow_retry: bool,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<R, ApiError>> + Send + 'a>> {
        Box::pin(async move {
            let key = self.load_server_key().await?;
            let sealed = seal_request(&key.public_key, &key.key_id, payload, now_secs())?;
            let url = format!("{}{path}", self.api_base_url);
            let resp = self
                .http
                .post(&url)
                .header("content-type", "text/plain")
                .header("origin", &self.api_base_url)
                .body(sealed.compact)
                .send()
                .await?;
            let status = resp.status().as_u16();
            let text = resp.text().await?;
            if status >= 400 {
                let err_body = serde_json::from_str::<ErrorBody>(&text).ok();
                let msg = err_body
                    .as_ref()
                    .and_then(|b| b.status_message.clone())
                    .unwrap_or_default();
                let log_id = err_body.and_then(|b| b.data).and_then(|d| d.log_id);
                if allow_retry && msg == ENVELOPE_REJECTED {
                    *self.server_key.lock().await = None;
                    return self.secure_post_inner(path, payload, false).await;
                }
                return Err(ApiError::Http {
                    status,
                    message: msg,
                    log_id,
                });
            }
            Ok(open_response::<R>(
                &text,
                &sealed.key_res,
                &sealed.request_id,
            )?)
        })
    }

    pub async fn get_json<R: DeserializeOwned>(&self, path: &str) -> Result<R, ApiError> {
        let url = format!("{}{path}", self.api_base_url);
        let resp = self.http.get(&url).send().await?;
        let status = resp.status().as_u16();
        if status >= 400 {
            return Err(ApiError::Http {
                status,
                message: String::new(),
                log_id: None,
            });
        }
        Ok(resp.json::<R>().await?)
    }
}

#[derive(Clone)]
pub struct SessionManager {
    secure: SecureHttp,
    vault: LocalVault,
    state: Arc<Mutex<SessionState>>,
    refresh_lock: Arc<Mutex<()>>,
}

impl SessionManager {
    pub fn new(secure: SecureHttp, vault: LocalVault) -> Self {
        Self {
            secure,
            vault,
            state: Arc::new(Mutex::new(SessionState::default())),
            refresh_lock: Arc::new(Mutex::new(())),
        }
    }

    async fn apply_session(&self, session: SessionResponse) -> Result<(), ApiError> {
        if let Some(ref rt) = session.refresh_token {
            let _ = self.vault.set_secret(REFRESH_SECRET_KEY, rt);
        }
        let mut st = self.state.lock().await;
        st.access_token = Some(Zeroizing::new(session.access_token));
        st.expires_at_ms = session.expires_at * 1000;
        st.user_id = Some(session.user_id);
        st.last_refresh_offline = false;
        Ok(())
    }

    pub async fn clear_local(&self) {
        let mut st = self.state.lock().await;
        st.access_token = None;
        st.expires_at_ms = 0;
        st.user_id = None;
    }

    pub async fn was_offline(&self) -> bool {
        self.state.lock().await.last_refresh_offline
    }

    pub async fn user_id(&self) -> Option<String> {
        self.state.lock().await.user_id.clone()
    }

    pub async fn login_with_password(
        &self,
        identifier: &str,
        password: &str,
    ) -> Result<KeyMaterial, ApiError> {
        let ident = identifier.trim().to_lowercase();
        let pre: PreloginResp = self
            .secure
            .secure_post("/api/auth/prelogin", &json!({ "identifier": ident }))
            .await?;
        let secrets =
            derive_password_secrets(password, &pre.salt).map_err(|_| ApiError::InvalidResponse)?;
        let session: SessionResponse = self
            .secure
            .secure_post(
                "/api/auth/login",
                &json!({
                    "identifier": ident,
                    "auth_secret": secrets.auth_secret.as_str(),
                    "native": true
                }),
            )
            .await?;
        self.apply_session(session).await?;
        Ok(KeyMaterial {
            wrap_key: secrets.wrap_key,
            salt: pre.salt,
        })
    }

    pub async fn register_account(
        &self,
        email: &str,
        username: &str,
        display_name: &str,
        password: &str,
    ) -> Result<RegisterOutcome, ApiError> {
        let salt = new_auth_salt().map_err(|_| ApiError::InvalidResponse)?;
        let secrets =
            derive_password_secrets(password, &salt).map_err(|_| ApiError::InvalidResponse)?;
        let res: RegisterResp = self
            .secure
            .secure_post(
                "/api/auth/register",
                &json!({
                    "email": email.trim(),
                    "username": username.trim().to_lowercase(),
                    "display_name": display_name.trim(),
                    "auth_secret": secrets.auth_secret.as_str(),
                    "auth_salt": salt,
                    "native": true
                }),
            )
            .await?;
        if res.status == "active" {
            let (Some(at), Some(exp), Some(uid)) = (res.access_token, res.expires_at, res.user_id)
            else {
                return Err(ApiError::InvalidResponse);
            };
            self.apply_session(SessionResponse {
                access_token: at,
                expires_at: exp,
                user_id: uid,
                refresh_token: res.refresh_token,
            })
            .await?;
            Ok(RegisterOutcome::Active(KeyMaterial {
                wrap_key: secrets.wrap_key,
                salt,
            }))
        } else {
            Ok(RegisterOutcome::VerifyEmail)
        }
    }

    pub async fn refresh_session(&self) -> Result<bool, ApiError> {
        let _guard = self.refresh_lock.lock().await;
        {
            let st = self.state.lock().await;
            if st.access_token.is_some() && now_millis() < st.expires_at_ms - REFRESH_MARGIN_MS {
                return Ok(true);
            }
        }
        let stored_rt = self.vault.get_secret(REFRESH_SECRET_KEY).ok().flatten();
        let Some(rt) = stored_rt else {
            return Ok(false);
        };
        match self
            .secure
            .secure_post::<_, SessionResponse>(
                "/api/auth/refresh",
                &json!({ "native": true, "refresh_token": rt.as_str() }),
            )
            .await
        {
            Ok(sess) => {
                self.apply_session(sess).await?;
                Ok(true)
            }
            Err(e) => {
                let offline = e.is_network_like();
                {
                    let mut st = self.state.lock().await;
                    st.last_refresh_offline = offline;
                    st.access_token = None;
                    st.expires_at_ms = 0;
                }
                if !offline {
                    let _ = self.vault.remove_secret(REFRESH_SECRET_KEY);
                }
                Ok(false)
            }
        }
    }

    pub async fn get_access_token(&self) -> Result<Option<Zeroizing<String>>, ApiError> {
        {
            let st = self.state.lock().await;
            if let Some(ref tok) = st.access_token {
                if now_millis() < st.expires_at_ms - REFRESH_MARGIN_MS {
                    return Ok(Some(tok.clone()));
                }
            }
        }
        if self.refresh_session().await? {
            let st = self.state.lock().await;
            return Ok(st.access_token.clone());
        }
        Ok(None)
    }

    pub async fn logout(&self) {
        let token = self.state.lock().await.access_token.clone();
        self.clear_local().await;
        let _ = self.vault.remove_secret(REFRESH_SECRET_KEY);
        let body = match token {
            Some(ref t) => json!({ "access_token": t.as_str() }),
            None => json!({}),
        };
        let _ = self
            .secure
            .secure_post::<_, Value>("/api/auth/logout", &body)
            .await;
    }

    pub async fn change_password(
        &self,
        identifier: &str,
        old_password: &str,
        new_password: &str,
        keyring: &SecretKeyring,
        user_id: &str,
    ) -> Result<(), ApiError> {
        let token = self
            .get_access_token()
            .await?
            .ok_or(ApiError::Unauthorized)?;
        let pre: PreloginResp = self
            .secure
            .secure_post("/api/auth/prelogin", &json!({ "identifier": identifier }))
            .await?;
        let old_sec = derive_password_secrets(old_password, &pre.salt)
            .map_err(|_| ApiError::InvalidResponse)?;
        let new_salt = new_auth_salt().map_err(|_| ApiError::InvalidResponse)?;
        let new_sec = derive_password_secrets(new_password, &new_salt)
            .map_err(|_| ApiError::InvalidResponse)?;
        let backup = create_key_backup(keyring, &new_sec.wrap_key, user_id, &new_salt)
            .map_err(|_| ApiError::InvalidResponse)?;
        let _: Value = self
            .secure
            .secure_post(
                "/api/auth/change-password",
                &json!({
                    "access_token": token.as_str(),
                    "old_auth_secret": old_sec.auth_secret.as_str(),
                    "new_auth_secret": new_sec.auth_secret.as_str(),
                    "new_auth_salt": new_salt,
                    "encrypted_keys": backup.encrypted_keys,
                    "nonce": backup.nonce,
                    "kdf_params": backup.kdf_params,
                }),
            )
            .await?;
        Ok(())
    }
}

#[derive(Clone)]
pub struct SupabaseRpc {
    http: Client,
    supabase_url: String,
    anon_key: String,
    session: SessionManager,
    vault: LocalVault,
    visitor_key: Arc<Mutex<Option<String>>>,
}

impl SupabaseRpc {
    pub fn new(env: &AppEnv, session: SessionManager, vault: LocalVault) -> Result<Self, ApiError> {
        let http = Client::builder().timeout(Duration::from_secs(20)).build()?;
        Ok(Self {
            http,
            supabase_url: env.supabase_url.trim_end_matches('/').to_string(),
            anon_key: env.supabase_anon_key.clone(),
            session,
            vault,
            visitor_key: Arc::new(Mutex::new(None)),
        })
    }

    pub async fn ensure_visitor_key(&self) -> Result<String, ApiError> {
        {
            let guard = self.visitor_key.lock().await;
            if let Some(ref vk) = *guard {
                return Ok(vk.clone());
            }
        }
        let vk = match self.vault.get_secret(VISITOR_SECRET_KEY)? {
            Some(existing)
                if existing.len() == 64 && existing.bytes().all(|b| b.is_ascii_hexdigit()) =>
            {
                existing.to_string()
            }
            _ => {
                let raw = random_bytes::<32>().map_err(|_| ApiError::InvalidResponse)?;
                let generated = hex::encode(*raw);
                self.vault.set_secret(VISITOR_SECRET_KEY, &generated)?;
                generated
            }
        };
        let mut guard = self.visitor_key.lock().await;
        *guard = Some(vk.clone());
        Ok(vk)
    }

    pub async fn rpc<R: DeserializeOwned, P: Serialize>(
        &self,
        fn_name: &str,
        args: &P,
    ) -> Result<R, ApiError> {
        if self.supabase_url.is_empty() || self.anon_key.is_empty() {
            return Err(ApiError::Unconfigured);
        }
        let visitor = self.ensure_visitor_key().await?;
        let token = self
            .session
            .get_access_token()
            .await?
            .ok_or(ApiError::Unauthorized)?;
        let url = format!("{}/rest/v1/rpc/{fn_name}", self.supabase_url);
        let resp = self
            .http
            .post(&url)
            .header("apikey", &self.anon_key)
            .header("authorization", format!("Bearer {}", token.as_str()))
            .header("x-visitor-key", &visitor)
            .json(args)
            .send()
            .await?;
        let status = resp.status().as_u16();
        let text = resp.text().await?;
        if status >= 400 {
            let err = serde_json::from_str::<PostgrestErrorBody>(&text).ok();
            return Err(ApiError::Rpc {
                status,
                code: err.as_ref().and_then(|e| e.code.clone()),
                message: err.and_then(|e| e.message).unwrap_or(text),
            });
        }
        let body = if text.trim().is_empty() {
            "null"
        } else {
            text.as_str()
        };
        serde_json::from_str::<R>(body).map_err(|e| ApiError::Rpc {
            status,
            code: Some("decode".to_string()),
            message: format!("{fn_name}: {e}"),
        })
    }

    pub async fn me(&self) -> Result<Me, ApiError> {
        self.rpc("seru24_me", &json!({})).await
    }

    pub async fn update_profile(&self, display_name: &str) -> Result<String, ApiError> {
        #[derive(Deserialize)]
        struct ProfileRes {
            display_name: String,
        }
        let res: ProfileRes = self
            .rpc(
                "seru24_update_profile",
                &json!({ "p_display_name": display_name }),
            )
            .await?;
        Ok(res.display_name)
    }

    pub async fn register_device(
        &self,
        platform: &str,
        name: &str,
        after_login: bool,
    ) -> Result<(), ApiError> {
        let _: Value = self
            .rpc(
                "seru24_register_device",
                &json!({
                    "p_platform": platform,
                    "p_name": name,
                    "p_after_login": after_login
                }),
            )
            .await?;
        Ok(())
    }

    pub async fn set_initial_keys(
        &self,
        pub_b64: &str,
        backup: &KeyBackup,
    ) -> Result<(), ApiError> {
        let _: Value = self
            .rpc(
                "seru24_set_initial_keys",
                &json!({
                    "p_public_key": pub_b64,
                    "p_encrypted_keys": backup.encrypted_keys,
                    "p_nonce": backup.nonce,
                    "p_kdf": backup.kdf,
                    "p_kdf_params": backup.kdf_params,
                }),
            )
            .await?;
        Ok(())
    }

    pub async fn get_key_backup(&self) -> Result<Option<KeyBackup>, ApiError> {
        self.rpc("seru24_get_key_backup", &json!({})).await
    }

    pub async fn trust_device(&self) -> Result<(), ApiError> {
        let _: Value = self.rpc("seru24_trust_device", &json!({})).await?;
        Ok(())
    }

    pub async fn list_conversations(
        &self,
        opts: &ListConversationsOptions,
    ) -> Result<Vec<Conversation>, ApiError> {
        self.rpc("seru24_list_conversations", opts).await
    }

    pub async fn get_messages(
        &self,
        conversation_id: &str,
        before_seq: Option<i64>,
        limit: usize,
    ) -> Result<Vec<ChatMessage>, ApiError> {
        let mut args = json!({
            "p_conversation_id": conversation_id,
            "p_limit": limit as u32
        });
        if let Some(seq) = before_seq {
            if let Some(obj) = args.as_object_mut() {
                obj.insert("p_before_seq".to_string(), json!(seq));
            }
        }
        self.rpc("seru24_get_messages", &args).await
    }

    pub async fn get_public_keys(&self, user_id: &str) -> Result<Vec<PublicKeyRow>, ApiError> {
        self.rpc("seru24_get_public_keys", &json!({ "p_user": user_id }))
            .await
    }

    pub async fn search_user(&self, username: &str) -> Result<Vec<FoundUser>, ApiError> {
        let clean = username.trim().trim_start_matches('@').to_lowercase();
        self.rpc("seru24_search_user", &json!({ "p_username": clean }))
            .await
    }

    pub async fn start_direct_chat(&self, target_id: &str) -> Result<Option<String>, ApiError> {
        #[derive(Deserialize)]
        struct StartRes {
            ok: bool,
            conversation_id: Option<String>,
        }
        let res: StartRes = self
            .rpc(
                "seru24_start_direct_chat",
                &json!({ "p_target": target_id }),
            )
            .await?;
        Ok(if res.ok { res.conversation_id } else { None })
    }

    pub async fn accept_chat(&self, conversation_id: &str) -> Result<bool, ApiError> {
        self.rpc(
            "seru24_accept_chat",
            &json!({ "p_conversation_id": conversation_id }),
        )
        .await
    }

    pub async fn delete_message(&self, message_id: &str) -> Result<bool, ApiError> {
        self.rpc(
            "seru24_delete_message",
            &json!({ "p_message_id": message_id }),
        )
        .await
    }

    pub async fn mark_read(&self, conversation_id: &str, seq: i64) -> Result<(), ApiError> {
        let _: Value = self
            .rpc(
                "seru24_mark_read",
                &json!({ "p_conversation_id": conversation_id, "p_seq": seq }),
            )
            .await?;
        Ok(())
    }

    pub async fn peer_read_seq(&self, conversation_id: &str) -> Result<i64, ApiError> {
        self.rpc(
            "seru24_peer_read_seq",
            &json!({ "p_conversation_id": conversation_id }),
        )
        .await
    }

    pub async fn set_blocked(&self, target_id: &str, blocked: bool) -> Result<(), ApiError> {
        let fn_name = if blocked {
            "seru24_block_user"
        } else {
            "seru24_unblock_user"
        };
        let _: Value = self.rpc(fn_name, &json!({ "p_target": target_id })).await?;
        Ok(())
    }

    pub async fn register_push_token(&self, platform: &str, token: &str) -> Result<(), ApiError> {
        let _: Value = self
            .rpc(
                "seru24_register_push_token",
                &json!({ "p_platform": platform, "p_token": token }),
            )
            .await?;
        Ok(())
    }

    pub async fn unregister_push_token(&self, token: &str) -> Result<(), ApiError> {
        let _: Value = self
            .rpc("seru24_unregister_push_token", &json!({ "p_token": token }))
            .await?;
        Ok(())
    }

    pub async fn schedule_message(&self, params: &Value) -> Result<ScheduleResult, ApiError> {
        self.rpc("seru24_schedule_message", params).await
    }

    pub async fn list_scheduled(
        &self,
        conversation_id: &str,
    ) -> Result<Vec<ScheduledRow>, ApiError> {
        self.rpc(
            "seru24_list_scheduled",
            &json!({ "p_conversation_id": conversation_id }),
        )
        .await
    }

    pub async fn cancel_scheduled(&self, id: &str) -> Result<(), ApiError> {
        let _: Value = self
            .rpc("seru24_cancel_scheduled", &json!({ "p_id": id }))
            .await?;
        Ok(())
    }
}

/// Kontainer sesi + akun + RPC + E2EE lengkap untuk UI dan CLI.
pub struct SeruClient {
    pub env: AppEnv,
    pub vault: LocalVault,
    pub secure: SecureHttp,
    pub session: SessionManager,
    pub rpc: SupabaseRpc,
    pub platform: String,
    pub device_name: String,
    pub me: Option<Me>,
    pub keyring: Option<SecretKeyring>,
    pub status: AccountStatus,
    pending_material: Option<KeyMaterial>,
}

impl SeruClient {
    pub fn new(
        env: AppEnv,
        vault: LocalVault,
        platform: impl Into<String>,
        device_name: impl Into<String>,
    ) -> Result<Self, ApiError> {
        let secure = SecureHttp::new(&env.api_base_url)?;
        let session = SessionManager::new(secure.clone(), vault.clone());
        let rpc = SupabaseRpc::new(&env, session.clone(), vault.clone())?;
        Ok(Self {
            env,
            vault,
            secure,
            session,
            rpc,
            platform: platform.into(),
            device_name: device_name.into(),
            me: None,
            keyring: None,
            status: AccountStatus::Unknown,
            pending_material: None,
        })
    }

    pub fn set_pending_key_material(&mut self, material: KeyMaterial) {
        self.pending_material = Some(material);
    }

    pub fn remember_me(&self) {
        if let Some(ref me) = self.me {
            let saved = SavedMe {
                id: me.id.clone(),
                username: me.username.clone(),
                display_name: me.display_name.clone(),
                has_keys: me.has_keys,
                key_version: me.key_version,
            };
            let _ = self.vault.set_json(LAST_ME_SECRET_KEY, &saved);
        }
    }

    pub fn load_cached_me(&mut self) -> bool {
        let Ok(Some(saved)) = self.vault.get_json::<SavedMe>(LAST_ME_SECRET_KEY) else {
            return false;
        };
        self.me = Some(Me {
            id: saved.id,
            username: saved.username,
            display_name: saved.display_name,
            has_keys: saved.has_keys,
            key_version: saved.key_version,
        });
        true
    }

    pub async fn bootstrap_account(
        &mut self,
        after_login: bool,
    ) -> Result<AccountStatus, ApiError> {
        let (reg_res, me_res) = tokio::join!(
            self.rpc
                .register_device(&self.platform, &self.device_name, after_login),
            self.rpc.me()
        );
        reg_res?;
        let mut me = me_res?;

        let mut ring = if me.has_keys {
            self.vault.load_keyring(&me.id).ok().flatten()
        } else {
            None
        };
        if let (Some(ref r), Some(ver)) = (&ring, me.key_version) {
            if !r.contains_key(&ver.to_string()) {
                ring = None;
            }
        } else if me.has_keys {
            ring = None;
        }

        let material = self.pending_material.take();
        if ring.is_none() {
            if let Some(mat) = material {
                if me.has_keys {
                    let backup = self
                        .rpc
                        .get_key_backup()
                        .await?
                        .ok_or(ApiError::InvalidResponseDetail("key_backup kosong"))?;
                    let opened = open_key_backup(&backup, &mat.wrap_key, &me.id)?;
                    self.rpc.trust_device().await?;
                    ring = Some(opened);
                } else {
                    let pair = generate_key_pair()?;
                    let mut created = BTreeMap::new();
                    created.insert("1".to_string(), pair.secret_key.clone());
                    let backup = create_key_backup(&created, &mat.wrap_key, &me.id, &mat.salt)?;
                    self.rpc
                        .set_initial_keys(&to_base64(&pair.public_key), &backup)
                        .await?;
                    me.has_keys = true;
                    me.key_version = Some(1);
                    ring = Some(created);
                }
                if let Some(ref r) = ring {
                    let _ = self.vault.save_keyring(&me.id, r);
                }
            }
        }

        self.status = if ring.is_some() {
            AccountStatus::Ready
        } else {
            AccountStatus::Locked
        };
        self.keyring = ring;
        self.me = Some(me);
        if self.status == AccountStatus::Ready {
            self.remember_me();
        }
        Ok(self.status)
    }

    pub async fn login_and_unlock(
        &mut self,
        identifier: &str,
        password: &str,
    ) -> Result<AccountStatus, ApiError> {
        let material = self
            .session
            .login_with_password(identifier, password)
            .await?;
        self.set_pending_key_material(material);
        self.bootstrap_account(true).await
    }

    pub async fn restore_session(&mut self) -> AccountStatus {
        let _ = self.rpc.ensure_visitor_key().await;
        match self.session.get_access_token().await {
            Ok(Some(_)) => match self.bootstrap_account(false).await {
                Ok(AccountStatus::Ready) => AccountStatus::Ready,
                Ok(_) => {
                    self.sign_out().await;
                    AccountStatus::Unknown
                }
                Err(e) if e.is_network_like() => self.try_offline(),
                Err(_) => {
                    self.sign_out().await;
                    AccountStatus::Unknown
                }
            },
            _ if self.session.was_offline().await => self.try_offline(),
            _ => {
                let _ = self.vault.remove_secret(LAST_ME_SECRET_KEY);
                self.me = None;
                self.keyring = None;
                self.status = AccountStatus::Unknown;
                AccountStatus::Unknown
            }
        }
    }

    fn try_offline(&mut self) -> AccountStatus {
        let Some(ref me) = self.me else {
            return AccountStatus::Unknown;
        };
        if !me.has_keys {
            return AccountStatus::Unknown;
        }
        let Some(ver) = me.key_version else {
            return AccountStatus::Unknown;
        };
        if let Ok(Some(ring)) = self.vault.load_keyring(&me.id) {
            if ring.contains_key(&ver.to_string()) {
                self.keyring = Some(ring);
                self.status = AccountStatus::Offline;
                return AccountStatus::Offline;
            }
        }
        AccountStatus::Unknown
    }

    pub async fn sign_out(&mut self) {
        if let Some(ref me) = self.me {
            let _ = self.vault.remove_keyring(&me.id);
        }
        let _ = self.vault.remove_secret(LAST_ME_SECRET_KEY);
        self.me = None;
        self.keyring = None;
        self.pending_material = None;
        self.status = AccountStatus::Unknown;
        self.session.logout().await;
    }
}

pub fn test_parse_realtime(
    raw: &str,
    my_id: &str,
    state: &mut std::collections::HashMap<String, std::collections::HashSet<String>>,
) -> Option<crate::realtime::RealtimeEvent> {
    parse_incoming_frame(raw, my_id, state)
}
