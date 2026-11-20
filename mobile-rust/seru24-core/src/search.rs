//! Pencarian pesan lokal di perangkat (`web/shared/search-core.ts`).

use unicode_normalization::UnicodeNormalization;

const CONTEXT_CHARS: usize = 32;

#[derive(Debug, Clone)]
pub struct SearchableMessage {
    pub key: String,
    pub seq: i64,
    pub created_at: String,
    pub text: Option<String>,
    pub deleted: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SearchHit {
    pub key: String,
    pub seq: i64,
    pub created_at: String,
    pub before: String,
    pub match_text: String,
    pub after: String,
}

fn is_combining_mark(c: char) -> bool {
    matches!(c as u32, 0x0300..=0x036F | 0x1AB0..=0x1AFF | 0x1DC0..=0x1DFF | 0x20D0..=0x20FF | 0xFE20..=0xFE2F)
}

pub fn normalize_for_search(value: &str) -> String {
    value
        .nfd()
        .filter(|&c| !is_combining_mark(c))
        .flat_map(char::to_lowercase)
        .collect()
}

fn fold_with_byte_map(text: &str) -> (String, Vec<usize>) {
    let mut folded = String::new();
    let mut origin = Vec::new();
    for (byte_idx, ch) in text.char_indices() {
        let mut buf = [0u8; 4];
        let s = ch.encode_utf8(&mut buf);
        let norm = normalize_for_search(s);
        for _ in 0..norm.len() {
            origin.push(byte_idx);
        }
        folded.push_str(&norm);
    }
    (folded, origin)
}

fn snippet_of(text: &str, start_byte: usize, end_byte: usize) -> (String, String, String) {
    let before_slice = &text[..start_byte];
    let after_slice = &text[end_byte..];
    let before_chars: Vec<char> = before_slice.chars().collect();
    let from_char = before_chars.len().saturating_sub(CONTEXT_CHARS);
    let before_raw: String = before_chars[from_char..].iter().collect();
    let before = format!(
        "{}{}",
        if from_char > 0 { "…" } else { "" },
        before_raw.split_whitespace().collect::<Vec<_>>().join(" ")
    );

    let after_chars: Vec<char> = after_slice.chars().collect();
    let take_after = after_chars.len().min(CONTEXT_CHARS);
    let after_raw: String = after_chars[..take_after].iter().collect();
    let after = format!(
        "{}{}",
        after_raw.split_whitespace().collect::<Vec<_>>().join(" "),
        if take_after < after_chars.len() {
            "…"
        } else {
            ""
        }
    );

    (before, text[start_byte..end_byte].to_string(), after)
}

pub fn search_messages(
    messages: &[SearchableMessage],
    query: &str,
    limit: usize,
) -> Vec<SearchHit> {
    let norm_query = normalize_for_search(query);
    let terms: Vec<&str> = norm_query.split_whitespace().collect();
    if terms.is_empty() || limit == 0 {
        return Vec::new();
    }

    let mut ordered: Vec<&SearchableMessage> = messages.iter().collect();
    ordered.sort_by_key(|a| std::cmp::Reverse(a.seq));

    let mut hits = Vec::new();
    for message in ordered {
        if message.deleted {
            continue;
        }
        let Some(ref text) = message.text else {
            continue;
        };
        let (folded, origin) = fold_with_byte_map(text);
        let mut earliest: Option<(usize, usize)> = None;
        let mut matched_all = true;
        for term in &terms {
            if let Some(pos) = folded.find(term) {
                match earliest {
                    None => earliest = Some((pos, term.len())),
                    Some((best, _)) if pos < best => earliest = Some((pos, term.len())),
                    _ => {}
                }
            } else {
                matched_all = false;
                break;
            }
        }
        if !matched_all {
            continue;
        }
        let Some((at_folded, term_len)) = earliest else {
            continue;
        };
        let start_byte = origin.get(at_folded).copied().unwrap_or(0);
        let mut end_folded = at_folded + term_len;
        while end_folded < origin.len() && origin[end_folded] == start_byte {
            end_folded += 1;
        }
        let end_byte = origin.get(end_folded).copied().unwrap_or(text.len());
        let (before, match_text, after) = snippet_of(text, start_byte, end_byte);
        hits.push(SearchHit {
            key: message.key.clone(),
            seq: message.seq,
            created_at: message.created_at.clone(),
            before,
            match_text,
            after,
        });
        if hits.len() >= limit {
            break;
        }
    }
    hits
}
