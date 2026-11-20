//! Protokol Siaran Dekat / Nearby Connections (`web/shared/nearby-core.ts`).

use chrono::{DateTime, TimeZone, Utc};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::chat::{parse_iso_millis, DecryptedMessageView};
use crate::crypto::{MessageKind, MAX_TEXT_LENGTH};
use crate::e2ee::ChatMessage;
use crate::file::is_base64_key44;

pub const NEARBY_MAX_PAYLOAD_CHARS: usize = 30_000;
const MAX_CIPHERTEXT_CHARS: usize = MAX_TEXT_LENGTH * 4 + 256;
const MAX_ID_CHARS: usize = 64;
const FUTURE_SKEW_MS: i64 = 5 * 60_000;
const ENDPOINT_NAME_MAX: usize = 100;
const MAX_CONTACT_TAGS: usize = 10;
pub const NEARBY_INBOX_LIMIT: usize = 200;

pub fn random_alias(random: &[u8]) -> String {
    let take = random.len().min(2);
    format!(
        "Anonim-{}",
        hex::encode(&random[..take]).to_ascii_uppercase()
    )
}

pub fn contact_tag(conversation_id: &str, user_id: &str) -> String {
    let input = format!("seru24/radar/v1:{conversation_id}:{user_id}");
    let digest = hex::encode(Sha256::digest(input.as_bytes()));
    digest[..8].to_string()
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EndpointName {
    pub alias: String,
    pub id: String,
    pub tags: Vec<String>,
}

pub fn build_endpoint_name(name: &EndpointName) -> String {
    let head = format!("s1|{}|{}|", name.alias, name.id);
    let mut tags: Vec<&str> = Vec::new();
    for tag in name.tags.iter().take(MAX_CONTACT_TAGS) {
        let mut candidate = String::with_capacity(ENDPOINT_NAME_MAX);
        candidate.push_str(&head);
        for (idx, t) in tags.iter().enumerate() {
            if idx > 0 {
                candidate.push(',');
            }
            candidate.push_str(t);
        }
        if !tags.is_empty() {
            candidate.push(',');
        }
        candidate.push_str(tag);
        if candidate.len() > ENDPOINT_NAME_MAX {
            break;
        }
        tags.push(tag.as_str());
    }
    format!("{head}{}", tags.join(","))
}

fn is_hex_upper(s: &str, len: usize) -> bool {
    s.len() == len
        && s.bytes()
            .all(|b| b.is_ascii_digit() || (b'A'..=b'F').contains(&b))
}

fn is_hex_lower(s: &str, len: usize) -> bool {
    s.len() == len
        && s.bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

pub fn parse_endpoint_name(raw: &str) -> Option<EndpointName> {
    let parts: Vec<&str> = raw.split('|').collect();
    if parts.len() != 4 || parts[0] != "s1" {
        return None;
    }
    let (alias, id, tag_list) = (parts[1], parts[2], parts[3]);
    let suffix = alias.strip_prefix("Anonim-")?;
    if !is_hex_upper(suffix, 4) || !is_hex_lower(id, 8) {
        return None;
    }
    let tags: Vec<String> = if tag_list.is_empty() {
        Vec::new()
    } else {
        tag_list.split(',').map(str::to_string).collect()
    };
    if tags.len() <= MAX_CONTACT_TAGS && tags.iter().all(|t| is_hex_lower(t, 8)) {
        Some(EndpointName {
            alias: alias.to_string(),
            id: id.to_string(),
            tags,
        })
    } else {
        None
    }
}

pub fn should_initiate(local_id: &str, peer_id: &str) -> bool {
    local_id < peer_id
}

pub fn stranger_conversation_id(user_a: &str, user_b: &str) -> String {
    if user_a <= user_b {
        format!("radar:{user_a}:{user_b}")
    } else {
        format!("radar:{user_b}:{user_a}")
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct NearbyHello {
    pub u: String,
    pub n: String,
    pub k: u32,
    pub pk: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct NearbyMessage {
    pub client_msg_id: String,
    pub ciphertext: String,
    pub nonce: String,
    pub sender_key_version: u32,
    pub recipient_key_version: u32,
    pub reply_to: Option<String>,
    pub created_at: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct NearbySendParams {
    pub p_client_msg_id: String,
    pub p_ciphertext: String,
    pub p_nonce: String,
    pub p_sender_key_version: u32,
    pub p_recipient_key_version: u32,
    pub p_reply_to: Option<String>,
}

pub fn encode_nearby_hello(hello: &NearbyHello) -> String {
    serde_json::to_string(&NearbyWire::Hello { h: hello.clone() }).unwrap_or_default()
}

pub fn encode_nearby_message(params: &NearbySendParams, created_at: &str) -> String {
    serde_json::to_string(&NearbyWire::Msg {
        m: NearbyMessage {
            client_msg_id: params.p_client_msg_id.clone(),
            ciphertext: params.p_ciphertext.clone(),
            nonce: params.p_nonce.clone(),
            sender_key_version: params.p_sender_key_version,
            recipient_key_version: params.p_recipient_key_version,
            reply_to: params.p_reply_to.clone(),
            created_at: created_at.to_string(),
        },
    })
    .unwrap_or_default()
}

pub fn encode_nearby_ack(client_msg_id: &str) -> String {
    serde_json::to_string(&NearbyWire::Ack {
        id: client_msg_id.to_string(),
    })
    .unwrap_or_default()
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "t")]
pub enum NearbyWire {
    #[serde(rename = "hello")]
    Hello { h: NearbyHello },
    #[serde(rename = "msg")]
    Msg { m: NearbyMessage },
    #[serde(rename = "ack")]
    Ack { id: String },
}

fn is_short(s: &str, max: usize) -> bool {
    !s.is_empty() && s.len() <= max
}

fn valid_username(s: &str) -> bool {
    (3..=30).contains(&s.len())
        && s.bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'_')
}

fn valid_version(v: u32) -> bool {
    (1..=1_000_000).contains(&v)
}

pub fn parse_nearby_wire(raw: &str) -> Option<NearbyWire> {
    if raw.len() > NEARBY_MAX_PAYLOAD_CHARS + 2_000 {
        return None;
    }
    let wire: NearbyWire = serde_json::from_str(raw).ok()?;
    match &wire {
        NearbyWire::Ack { id } => is_short(id, MAX_ID_CHARS).then_some(wire),
        NearbyWire::Hello { h } => {
            if is_short(&h.u, MAX_ID_CHARS)
                && valid_username(&h.n)
                && valid_version(h.k)
                && is_base64_key44(&h.pk)
            {
                Some(wire)
            } else {
                None
            }
        }
        NearbyWire::Msg { m } => {
            let reply_ok = m
                .reply_to
                .as_deref()
                .map(|r| is_short(r, MAX_ID_CHARS))
                .unwrap_or(true);
            if is_short(&m.client_msg_id, MAX_ID_CHARS)
                && is_short(&m.ciphertext, MAX_CIPHERTEXT_CHARS)
                && is_short(&m.nonce, 64)
                && valid_version(m.sender_key_version)
                && valid_version(m.recipient_key_version)
                && reply_ok
                && is_short(&m.created_at, 40)
            {
                Some(wire)
            } else {
                None
            }
        }
    }
}

pub fn clamp_created_at(value: &str, now_millis: i64) -> String {
    let parsed = parse_iso_millis(Some(value));
    let target =
        if DateTime::parse_from_rfc3339(value).is_err() || parsed > now_millis + FUTURE_SKEW_MS {
            now_millis
        } else {
            parsed
        };
    Utc.timestamp_millis_opt(target)
        .single()
        .unwrap_or_else(Utc::now)
        .to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

pub fn nearby_as_message(
    m: &NearbyMessage,
    conversation_id: &str,
    peer_id: &str,
    now_millis: i64,
) -> ChatMessage {
    let clamped = clamp_created_at(&m.created_at, now_millis);
    ChatMessage {
        id: m.client_msg_id.clone(),
        conversation_id: conversation_id.to_string(),
        sender_id: Some(peer_id.to_string()),
        seq: 0,
        client_msg_id: m.client_msg_id.clone(),
        kind: MessageKind::Text,
        ciphertext: Some(m.ciphertext.clone()),
        nonce: Some(m.nonce.clone()),
        sender_key_version: m.sender_key_version,
        recipient_key_version: m.recipient_key_version,
        reply_to: m.reply_to.clone(),
        created_at: clamped.clone(),
        offline_sent_at: Some(clamped),
        edited_at: None,
        deleted_at: None,
        expires_at: None,
    }
}

pub fn add_to_nearby_inbox(inbox: &mut Vec<DecryptedMessageView>, item: DecryptedMessageView) {
    if inbox.iter().any(|x| x.client_msg_id == item.client_msg_id) {
        return;
    }
    inbox.push(item);
    if inbox.len() > NEARBY_INBOX_LIMIT {
        let excess = inbox.len() - NEARBY_INBOX_LIMIT;
        inbox.drain(0..excess);
    }
}
