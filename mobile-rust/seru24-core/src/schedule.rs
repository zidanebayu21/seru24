//! Logika kirim terjadwal (`web/shared/schedule-core.ts`).

use chrono::{DateTime, Datelike, Duration, Local, NaiveTime, TimeZone};
use serde::{Deserialize, Serialize};

use crate::crypto::MessageKind;
use crate::e2ee::ChatMessage;

pub const MIN_SCHEDULE_LEAD_MS: i64 = 60_000;
pub const MAX_SCHEDULE_LEAD_MS: i64 = 30 * 86_400_000;
pub const MAX_PENDING_SCHEDULED: usize = 20;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ScheduleProblem {
    TooSoon,
    TooFar,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SchedulePreset {
    pub label: String,
    pub at: DateTime<Local>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ScheduledRow {
    pub id: String,
    pub client_msg_id: String,
    pub ciphertext: String,
    pub nonce: String,
    pub sender_key_version: u32,
    pub recipient_key_version: u32,
    pub send_at: String,
    pub status: String,
    pub error_code: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ScheduleResult {
    pub ok: bool,
    pub code: Option<String>,
    pub id: Option<String>,
    pub send_at: Option<String>,
}

pub fn schedule_error_message(code: &str) -> &'static str {
    match code {
        "device_not_registered" => "Perangkat belum terdaftar. Buka ulang aplikasi.",
        "not_member" => "Percakapan tidak ditemukan.",
        "unavailable" => "Pesan tidak dapat dikirim.",
        "too_soon" => "Pilih waktu minimal 1 menit dari sekarang.",
        "too_far" => "Maksimal 30 hari ke depan.",
        "stale_key" => "Kunci lawan bicara berubah. Jadwalkan ulang pesan ini.",
        "invalid_reply" => "Pesan yang dibalas tidak ditemukan.",
        "too_many" => "Maksimal 20 pesan terjadwal sekaligus.",
        "rate_limited" => "Terlalu cepat. Tunggu sebentar.",
        "not_ready" => "Pesan terjadwal belum tersedia. Coba lagi nanti.",
        "internal" => "Terjadi kesalahan di server.",
        _ => "Pesan terjadwal gagal dikirim.",
    }
}

fn with_time(base: DateTime<Local>, day_offset: i64, hour: u32, minute: u32) -> DateTime<Local> {
    let target_date = base.date_naive() + Duration::days(day_offset);
    let time = NaiveTime::from_hms_opt(hour, minute, 0).unwrap_or(NaiveTime::MIN);
    let naive = target_date.and_time(time);
    Local.from_local_datetime(&naive).earliest().unwrap_or(base)
}

pub fn schedule_presets(now: DateTime<Local>) -> Vec<SchedulePreset> {
    let mut presets = vec![SchedulePreset {
        label: "Dalam 1 jam".to_string(),
        at: now + Duration::hours(1),
    }];
    let tonight = with_time(now, 0, 20, 0);
    if (tonight - now).num_milliseconds() > 3_600_000 + MIN_SCHEDULE_LEAD_MS {
        presets.push(SchedulePreset {
            label: "Nanti malam 20.00".to_string(),
            at: tonight,
        });
    }
    presets.push(SchedulePreset {
        label: "Besok pagi 08.00".to_string(),
        at: with_time(now, 1, 8, 0),
    });
    let weekday_num = now.weekday().num_days_from_sunday() as i64;
    let mut days_to_monday = (8 - weekday_num) % 7;
    if days_to_monday == 0 {
        days_to_monday = 7;
    }
    if days_to_monday > 1 {
        presets.push(SchedulePreset {
            label: "Senin 08.00".to_string(),
            at: with_time(now, days_to_monday, 8, 0),
        });
    }
    presets
}

pub fn validate_schedule_time(
    at: DateTime<Local>,
    now: DateTime<Local>,
) -> Option<ScheduleProblem> {
    let lead = (at - now).num_milliseconds();
    if lead < MIN_SCHEDULE_LEAD_MS {
        return Some(ScheduleProblem::TooSoon);
    }
    if lead > MAX_SCHEDULE_LEAD_MS {
        return Some(ScheduleProblem::TooFar);
    }
    None
}

pub fn parse_clock_input(text: &str, now: DateTime<Local>) -> Option<DateTime<Local>> {
    let trimmed = text.trim();
    let (h_str, m_str) =
        if let Some(pair) = trimmed.split_once('.').or_else(|| trimmed.split_once(':')) {
            (pair.0, Some(pair.1))
        } else {
            (trimmed, None)
        };
    if !(1..=2).contains(&h_str.len()) || !h_str.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    let hour: u32 = h_str.parse().ok()?;
    let minute: u32 = match m_str {
        Some(ms) => {
            if ms.len() != 2 || !ms.bytes().all(|b| b.is_ascii_digit()) {
                return None;
            }
            ms.parse().ok()?
        }
        None => 0,
    };
    if hour > 23 || minute > 59 {
        return None;
    }
    let today = with_time(now, 0, hour, minute);
    if (today - now).num_milliseconds() >= MIN_SCHEDULE_LEAD_MS {
        Some(today)
    } else {
        Some(with_time(now, 1, hour, minute))
    }
}

pub fn scheduled_as_message(row: &ScheduledRow, conversation_id: &str, my_id: &str) -> ChatMessage {
    ChatMessage {
        id: row.id.clone(),
        conversation_id: conversation_id.to_string(),
        sender_id: Some(my_id.to_string()),
        seq: 0,
        client_msg_id: row.client_msg_id.clone(),
        kind: MessageKind::Text,
        ciphertext: Some(row.ciphertext.clone()),
        nonce: Some(row.nonce.clone()),
        sender_key_version: row.sender_key_version,
        recipient_key_version: row.recipient_key_version,
        reply_to: None,
        created_at: row.send_at.clone(),
        offline_sent_at: None,
        edited_at: None,
        deleted_at: None,
        expires_at: None,
    }
}
