//! Cuplikan pesan terakhir di daftar chat (`web/shared/preview-core.ts`).

use serde::{Deserialize, Serialize};

use crate::chat::parse_iso_millis;

pub const PREVIEW_MAX: usize = 90;
pub const DELETED_PREVIEW: &str = "Pesan dihapus";

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Preview {
    pub text: String,
    pub mine: bool,
    pub at: String,
}

pub fn preview_text(raw: &str, mine: bool) -> String {
    let one_line = raw.split_whitespace().collect::<Vec<_>>().join(" ");
    if one_line.is_empty() {
        return String::new();
    }
    let count = one_line.chars().count();
    let cut = if count > PREVIEW_MAX {
        let prefix: String = one_line.chars().take(PREVIEW_MAX - 1).collect();
        format!("{}…", prefix.trim_end())
    } else {
        one_line
    };
    if mine {
        format!("Anda: {cut}")
    } else {
        cut
    }
}

pub fn is_fresh_preview(preview: Option<&Preview>, last_message_at: Option<&str>) -> bool {
    match (preview, last_message_at) {
        (Some(p), Some(at)) => parse_iso_millis(Some(&p.at)) >= parse_iso_millis(Some(at)),
        _ => false,
    }
}

pub fn deleted_preview(at: &str) -> Preview {
    Preview {
        text: DELETED_PREVIEW.to_string(),
        mine: false,
        at: at.to_string(),
    }
}
