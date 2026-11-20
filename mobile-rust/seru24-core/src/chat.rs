//! Tipe dan helper percakapan (`web/shared/chat-core.ts`).

use std::cmp::Ordering;
use std::collections::{HashMap, HashSet};

use chrono::{DateTime, Local, Utc};
use serde::{Deserialize, Serialize};

use crate::crypto::MessageKind;

pub const CHAT_PAGE_SIZE: usize = 50;
pub const CHAT_PREFETCH_OFFSET: usize = 10;
pub const CHAT_MOBILE_PREFETCH_SCREENS: usize = 1;
pub const CONVERSATION_PAGE_SIZE: usize = 50;
pub const REPLY_SNIPPET_LENGTH: usize = 80;

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct ListConversationsOptions {
    #[serde(rename = "p_limit", skip_serializing_if = "Option::is_none")]
    pub limit: Option<u32>,
    #[serde(rename = "p_offset", skip_serializing_if = "Option::is_none")]
    pub offset: Option<u32>,
    #[serde(rename = "p_id", skip_serializing_if = "Option::is_none")]
    pub id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ConversationStatus {
    Pending,
    Accepted,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Conversation {
    pub id: String,
    pub status: ConversationStatus,
    pub requested_by: Option<String>,
    pub last_message_at: Option<String>,
    pub unread: i64,
    pub muted: bool,
    pub archived: bool,
    pub pinned: bool,
    pub peer_id: String,
    pub peer_username: String,
    pub peer_display_name: String,
    pub peer_blocked: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct FoundUser {
    pub id: String,
    pub username: String,
    pub display_name: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SendResult {
    pub ok: bool,
    pub code: Option<String>,
    pub id: Option<String>,
    pub seq: Option<i64>,
    pub created_at: Option<String>,
    pub offline_sent_at: Option<String>,
}

pub fn send_error_message(code: &str) -> Option<&'static str> {
    match code {
        "device_not_registered" => Some("Perangkat belum terdaftar. Buka ulang aplikasi."),
        "not_member" => Some("Percakapan tidak ditemukan."),
        "unavailable" => Some("Pesan tidak dapat dikirim."),
        "stale_key" => Some("Kunci lawan bicara berubah. Coba kirim lagi."),
        "rate_limited" => Some("Terlalu banyak pesan. Tunggu sebentar."),
        "unsupported_kind" => Some("Jenis pesan belum didukung."),
        _ => None,
    }
}

pub fn peer_label(peer_display_name: &str, peer_username: &str) -> String {
    if peer_display_name.is_empty() {
        format!("@{peer_username}")
    } else {
        peer_display_name.to_string()
    }
}

pub fn is_incoming_request(conv: &Conversation, my_id: Option<&str>) -> bool {
    conv.status == ConversationStatus::Pending && conv.requested_by.as_deref() != my_id
}

pub fn append_conversations(current: &[Conversation], page: &[Conversation]) -> Vec<Conversation> {
    let known: HashSet<&str> = current.iter().map(|c| c.id.as_str()).collect();
    let mut out = current.to_vec();
    for conv in page {
        if !known.contains(conv.id.as_str()) {
            out.push(conv.clone());
        }
    }
    out
}

pub fn cacheable_conversations(
    fresh: &[Conversation],
    cached: &[Conversation],
    has_more: bool,
) -> Vec<Conversation> {
    if has_more {
        append_conversations(fresh, cached)
    } else {
        fresh.to_vec()
    }
}

pub fn parse_iso_millis(iso: Option<&str>) -> i64 {
    iso.and_then(|s| DateTime::parse_from_rfc3339(s).ok())
        .map(|dt| dt.timestamp_millis())
        .unwrap_or(0)
}

pub fn format_clock(iso: Option<&str>) -> String {
    let Some(s) = iso else {
        return String::new();
    };
    let Ok(dt) = DateTime::parse_from_rfc3339(s) else {
        return String::new();
    };
    dt.with_timezone(&Local).format("%H.%M").to_string()
}

pub fn format_time(iso: Option<&str>) -> String {
    let Some(s) = iso else {
        return String::new();
    };
    let Ok(dt) = DateTime::parse_from_rfc3339(s) else {
        return String::new();
    };
    let local = dt.with_timezone(&Local);
    let now = Local::now();
    if local.date_naive() == now.date_naive() {
        local.format("%H.%M").to_string()
    } else {
        local.format("%d %b").to_string()
    }
}

pub fn format_day_label(iso: &str, now_local: DateTime<Local>) -> String {
    let Ok(dt) = DateTime::parse_from_rfc3339(iso) else {
        return String::new();
    };
    let local = dt.with_timezone(&Local);
    let days = (now_local.date_naive() - local.date_naive()).num_days();
    if days == 0 {
        return "Hari ini".to_string();
    }
    if days == 1 {
        return "Kemarin".to_string();
    }
    const MONTHS: [&str; 12] = [
        "Januari",
        "Februari",
        "Maret",
        "April",
        "Mei",
        "Juni",
        "Juli",
        "Agustus",
        "September",
        "Oktober",
        "November",
        "Desember",
    ];
    let month_name =
        MONTHS[(local.format("%m").to_string().parse::<usize>().unwrap_or(1) - 1).min(11)];
    if local.format("%Y").to_string() == now_local.format("%Y").to_string() {
        format!("{} {}", local.format("%-d"), month_name)
    } else {
        format!(
            "{} {} {}",
            local.format("%-d"),
            month_name,
            local.format("%Y")
        )
    }
}

pub fn message_time<'a>(created_at: &'a str, offline_sent_at: Option<&'a str>) -> &'a str {
    offline_sent_at.unwrap_or(created_at)
}

pub trait BubbleOrder {
    fn key(&self) -> &str;
    fn seq(&self) -> i64;
    fn pending(&self) -> bool;
    fn created_at(&self) -> Option<&str>;
    fn revised(&self) -> bool;
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PagedBubble {
    pub key: String,
    pub seq: i64,
    pub pending: bool,
    pub created_at: Option<String>,
    pub revised: bool,
}

impl BubbleOrder for PagedBubble {
    fn key(&self) -> &str {
        &self.key
    }
    fn seq(&self) -> i64 {
        self.seq
    }
    fn pending(&self) -> bool {
        self.pending
    }
    fn created_at(&self) -> Option<&str> {
        self.created_at.as_deref()
    }
    fn revised(&self) -> bool {
        self.revised
    }
}

/// Meniru `compareBubbles` di `web/shared/chat-core.ts` agar urutan bubble revisi & offline identik.
pub fn compare_bubbles<T: BubbleOrder>(a: &T, b: &T) -> Ordering {
    let unpersisted = |x: &T| x.pending() || x.seq() <= 0;
    match (unpersisted(a), unpersisted(b)) {
        (true, false) => return Ordering::Greater,
        (false, true) => return Ordering::Less,
        (true, true) => {
            return parse_iso_millis(a.created_at()).cmp(&parse_iso_millis(b.created_at()));
        }
        (false, false) => {}
    }

    if a.revised() || b.revised() {
        let ta = parse_iso_millis(a.created_at());
        let tb = parse_iso_millis(b.created_at());
        if ta != tb {
            return ta.cmp(&tb);
        }
    }
    a.seq().cmp(&b.seq())
}

pub fn merge_paged_bubbles<T: BubbleOrder + Clone>(incoming: &[T], current: &[T]) -> Vec<T> {
    let mut by_key: HashMap<String, T> = HashMap::new();
    for item in incoming {
        by_key.insert(item.key().to_string(), item.clone());
    }
    for item in current {
        by_key.insert(item.key().to_string(), item.clone());
    }
    let mut out: Vec<T> = by_key.into_values().collect();
    out.sort_by(compare_bubbles);
    out
}

pub fn oldest_persisted_seq<T: BubbleOrder>(items: &[T]) -> Option<i64> {
    items
        .iter()
        .filter(|item| !item.pending() && item.seq() > 0)
        .map(|item| item.seq())
        .min()
}

pub trait CacheableMsg {
    fn client_msg_id(&self) -> &str;
    fn seq(&self) -> i64;
    fn deleted_at(&self) -> Option<&str>;
    fn edited_at(&self) -> Option<&str>;
}

pub fn changed_messages<T: CacheableMsg + Clone>(known: &[T], fetched: &[T]) -> Vec<T> {
    let by_id: HashMap<&str, &T> = known.iter().map(|m| (m.client_msg_id(), m)).collect();
    fetched
        .iter()
        .filter(|m| match by_id.get(m.client_msg_id()) {
            None => true,
            Some(prev) => prev.deleted_at() != m.deleted_at() || prev.edited_at() != m.edited_at(),
        })
        .cloned()
        .collect()
}

pub fn merge_cached_messages<T: CacheableMsg + Clone>(
    cached: &[T],
    incoming: &[T],
    deleted_client_msg_ids: Option<&HashSet<String>>,
    cleared_up_to_seq: i64,
) -> Vec<T> {
    let keep = |item: &T| {
        let removed = deleted_client_msg_ids
            .map(|set| set.contains(item.client_msg_id()))
            .unwrap_or(false);
        !removed && item.seq() > cleared_up_to_seq
    };
    let mut by_id: HashMap<String, T> = HashMap::new();
    for item in cached.iter().filter(|i| keep(i)) {
        by_id.insert(item.client_msg_id().to_string(), item.clone());
    }
    for item in incoming.iter().filter(|i| keep(i)) {
        by_id.insert(item.client_msg_id().to_string(), item.clone());
    }
    let mut out: Vec<T> = by_id.into_values().collect();
    out.sort_by_key(|m| m.seq());
    out
}

pub fn slice_messages_page<T: CacheableMsg + Clone>(
    messages: &[T],
    before_seq: Option<i64>,
    limit: usize,
) -> (Vec<T>, bool) {
    let safe_limit = limit.max(1);
    let mut filtered: Vec<T> = match before_seq {
        Some(seq) => messages.iter().filter(|m| m.seq() < seq).cloned().collect(),
        None => messages.to_vec(),
    };
    filtered.sort_by_key(|m| m.seq());
    if filtered.len() <= safe_limit {
        return (filtered, false);
    }
    let start = filtered.len() - safe_limit;
    (filtered.split_off(start), true)
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StatusOutput {
    pub text: String,
    pub ticks: &'static str,
    pub read: bool,
}

pub fn bubble_status(
    pending: bool,
    failed: &str,
    mine: bool,
    seq: i64,
    created_at: &str,
    peer_read_seq: i64,
) -> StatusOutput {
    if pending {
        return StatusOutput {
            text: "mengirim…".to_string(),
            ticks: "",
            read: false,
        };
    }
    if !failed.is_empty() {
        return StatusOutput {
            text: failed.to_string(),
            ticks: "",
            read: false,
        };
    }
    let text = format_time(Some(created_at));
    if !mine {
        return StatusOutput {
            text,
            ticks: "",
            read: false,
        };
    }
    let read = seq > 0 && seq <= peer_read_seq;
    StatusOutput {
        text,
        ticks: if read { "✓✓" } else { "✓" },
        read,
    }
}

pub fn reply_snippet(text: Option<&str>, deleted: bool) -> String {
    if deleted {
        return "Pesan dihapus".to_string();
    }
    let Some(raw) = text else {
        return "Pesan tidak dapat dibuka".to_string();
    };
    let collapsed = raw.split_whitespace().collect::<Vec<_>>().join(" ");
    let mut chars = collapsed.chars();
    let head: String = chars.by_ref().take(REPLY_SNIPPET_LENGTH).collect();
    if chars.next().is_some() {
        format!("{head}…")
    } else {
        head
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DecryptedMessageView {
    pub id: String,
    pub client_msg_id: String,
    pub kind: MessageKind,
    pub mine: bool,
    pub seq: i64,
    pub text: Option<String>,
    pub reply_to: Option<String>,
    pub created_at: String,
    pub revised: bool,
    pub deleted: bool,
    pub pending: bool,
    pub failed: String,
}

pub fn now_iso_utc() -> String {
    Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

/// Warna avatar deterministik per username (`hsl(hue, 42%, 42%)`, setara `mobile/src/components/Avatar.tsx`).
pub fn avatar_rgb(seed: &str) -> (u8, u8, u8) {
    let hue = (seed.encode_utf16().map(u32::from).sum::<u32>() % 360) as f32;
    let s = 0.42_f32;
    let l = 0.42_f32;
    let c = (1.0 - (2.0 * l - 1.0).abs()) * s;
    let x = c * (1.0 - ((hue / 60.0) % 2.0 - 1.0).abs());
    let m = l - c / 2.0;
    let (r1, g1, b1) = match hue as u32 {
        0..=59 => (c, x, 0.0),
        60..=119 => (x, c, 0.0),
        120..=179 => (0.0, c, x),
        180..=239 => (0.0, x, c),
        240..=299 => (x, 0.0, c),
        _ => (c, 0.0, x),
    };
    let to_u8 = |v: f32| ((v + m) * 255.0).round().clamp(0.0, 255.0) as u8;
    (to_u8(r1), to_u8(g1), to_u8(b1))
}
