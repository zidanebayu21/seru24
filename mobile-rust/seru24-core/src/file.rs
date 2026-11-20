//! Aturan file & pesan suara bersama (`web/shared/file-core.ts`).

use serde::{Deserialize, Serialize};

pub const MAX_FILE_BYTES: u64 = 50 * 1024 * 1024;
pub const FILE_TAG_BYTES: u64 = 16;
pub const MAX_ENCRYPTED_BYTES: u64 = MAX_FILE_BYTES + FILE_TAG_BYTES;
pub const FILE_CHUNK_BYTES: usize = 3 * 1024 * 1024;
pub const MAX_FILE_NAME_LENGTH: usize = 200;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct FileMessageBody {
    pub id: String,
    pub name: String,
    pub mime: String,
    pub size: u64,
    pub key: String,
    pub iv: String,
}

pub fn is_uuid(value: &str) -> bool {
    let bytes = value.as_bytes();
    if bytes.len() != 36 {
        return false;
    }
    for (i, b) in bytes.iter().enumerate() {
        let expect_dash = matches!(i, 8 | 13 | 18 | 23);
        if expect_dash {
            if *b != b'-' {
                return false;
            }
        } else if !b.is_ascii_hexdigit() {
            return false;
        }
    }
    true
}

fn is_b64_char(b: u8) -> bool {
    b.is_ascii_alphanumeric() || b == b'+' || b == b'/'
}

pub fn is_base64_key44(value: &str) -> bool {
    let b = value.as_bytes();
    b.len() == 44 && b[43] == b'=' && b[..43].iter().copied().all(is_b64_char)
}

pub fn is_base64_iv16(value: &str) -> bool {
    let b = value.as_bytes();
    b.len() == 16 && b.iter().copied().all(is_b64_char)
}

pub fn safe_file_name(name: &str) -> String {
    let base = name.rsplit(['/', '\\']).next().unwrap_or("");
    let clean: String = base
        .chars()
        .filter(|&c| c >= ' ' && c != '\u{007f}')
        .collect();
    let trimmed = clean.trim();
    let candidate = if trimmed.is_empty() {
        "dokumen"
    } else {
        trimmed
    };
    candidate.chars().take(MAX_FILE_NAME_LENGTH).collect()
}

pub fn base_mime(mime: &str) -> String {
    mime.split(';')
        .next()
        .unwrap_or("")
        .trim()
        .to_ascii_lowercase()
}

pub fn is_voice_file(mime: &str) -> bool {
    matches!(
        base_mime(mime).as_str(),
        "audio/webm"
            | "audio/ogg"
            | "audio/mp4"
            | "audio/mpeg"
            | "audio/wav"
            | "audio/aac"
            | "audio/x-m4a"
    )
}

pub fn parse_file_body(value: &serde_json::Value) -> Option<FileMessageBody> {
    let obj = value.as_object()?;
    let id = obj.get("id")?.as_str()?;
    let name = obj.get("name")?.as_str()?;
    let mime = obj.get("mime")?.as_str()?;
    let size = obj.get("size")?.as_u64()?;
    let key = obj.get("key")?.as_str()?;
    let iv = obj.get("iv")?.as_str()?;
    if !is_uuid(id) || size > MAX_FILE_BYTES || !is_base64_key44(key) || !is_base64_iv16(iv) {
        return None;
    }
    Some(FileMessageBody {
        id: id.to_string(),
        name: safe_file_name(name),
        mime: mime.chars().take(100).collect(),
        size,
        key: key.to_string(),
        iv: iv.to_string(),
    })
}

pub fn chunk_ranges(total: usize, chunk: usize) -> Vec<(usize, usize)> {
    let mut ranges = Vec::new();
    let mut start = 0;
    while start < total {
        let end = (start + chunk).min(total);
        ranges.push((start, end));
        start = end;
    }
    ranges
}

pub fn format_file_size(bytes: u64) -> String {
    if bytes < 1024 {
        format!("{bytes} B")
    } else if bytes < 1024 * 1024 {
        format!("{:.1} KB", bytes as f64 / 1024.0)
    } else {
        format!("{:.1} MB", bytes as f64 / (1024.0 * 1024.0))
    }
}

pub fn format_clock_seconds(seconds: u64) -> String {
    format!("{}:{:02}", seconds / 60, seconds % 60)
}

pub fn voice_seconds_from_name(name: &str) -> Option<u64> {
    let dot = name.rfind('.')?;
    let stem = name[..dot].strip_suffix('s')?;
    let dash = stem.rfind('-')?;
    stem[dash + 1..].parse::<u64>().ok()
}
