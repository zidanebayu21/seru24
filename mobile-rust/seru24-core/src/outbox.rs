//! Antrean outbox offline & pengiriman ulang (`mobile/src/lib/outbox.ts`).
//! Hanya menyimpan parameter RPC yang sudah terenkripsi E2EE di vault terenkripsi.

use serde::{Deserialize, Serialize};

use crate::api::{ApiError, SupabaseRpc};
use crate::chat::SendResult;
use crate::e2ee::SealedMessageParams;
use crate::storage::{LocalVault, StorageError};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QueuedMessage {
    pub conversation_id: String,
    pub params: SealedMessageParams,
    pub queued_at: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FlushedItem {
    pub item: QueuedMessage,
    pub result: SendResult,
}

fn storage_key(user_id: &str) -> String {
    format!("outbox.{user_id}")
}

/// Mengirim pesan beserta `p_offline_sent_at`; fallback tanpa parameter itu bila `PGRST202`.
pub async fn send_with_offline_time(
    rpc: &SupabaseRpc,
    params: &SealedMessageParams,
    offline_sent_at: &str,
) -> Result<SendResult, ApiError> {
    let mut with_time = serde_json::to_value(params).map_err(|_| ApiError::InvalidResponse)?;
    if let Some(obj) = with_time.as_object_mut() {
        obj.insert(
            "p_offline_sent_at".to_string(),
            serde_json::Value::String(offline_sent_at.to_string()),
        );
    }
    match rpc
        .rpc::<SendResult, _>("seru24_send_message", &with_time)
        .await
    {
        Ok(res) => Ok(res),
        Err(ApiError::Rpc {
            code: Some(ref code),
            ..
        }) if code == "PGRST202" => rpc.rpc("seru24_send_message", params).await,
        Err(e) => Err(e),
    }
}

pub fn load_outbox(vault: &LocalVault, user_id: &str) -> Result<Vec<QueuedMessage>, StorageError> {
    if user_id.is_empty() {
        return Ok(Vec::new());
    }
    Ok(vault
        .get_json::<Vec<QueuedMessage>>(&storage_key(user_id))?
        .unwrap_or_default())
}

fn save_outbox(
    vault: &LocalVault,
    user_id: &str,
    items: &[QueuedMessage],
) -> Result<(), StorageError> {
    vault.set_json(&storage_key(user_id), &items)
}

pub fn queue_message(
    vault: &LocalVault,
    user_id: &str,
    item: QueuedMessage,
) -> Result<(), StorageError> {
    let mut items = load_outbox(vault, user_id)?;
    if !items
        .iter()
        .any(|x| x.params.p_client_msg_id == item.params.p_client_msg_id)
    {
        items.push(item);
        save_outbox(vault, user_id, &items)?;
    }
    Ok(())
}

pub fn queued_for(
    vault: &LocalVault,
    user_id: &str,
    conversation_id: &str,
) -> Result<Vec<QueuedMessage>, StorageError> {
    Ok(load_outbox(vault, user_id)?
        .into_iter()
        .filter(|x| x.conversation_id == conversation_id)
        .collect())
}

/// Mengirim seluruh antrean berurutan; berhenti di gangguan jaringan pertama agar tetap di antrean.
pub async fn flush_outbox(
    vault: &LocalVault,
    rpc: &SupabaseRpc,
    user_id: &str,
) -> Result<Vec<FlushedItem>, StorageError> {
    let mut items = load_outbox(vault, user_id)?;
    let mut delivered = Vec::new();
    while !items.is_empty() {
        let head = items[0].clone();
        match send_with_offline_time(rpc, &head.params, &head.queued_at).await {
            Ok(result) => {
                items.remove(0);
                save_outbox(vault, user_id, &items)?;
                delivered.push(FlushedItem { item: head, result });
            }
            Err(_) => {
                // Jaringan/sesi belum pulih: pertahankan sisa antrean untuk percobaan berikutnya.
                break;
            }
        }
    }
    Ok(delivered)
}
