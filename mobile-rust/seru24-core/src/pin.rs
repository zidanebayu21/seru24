//! Logika pin pesan lokal (`web/shared/pin-core.ts`).

use std::collections::HashSet;

pub const MAX_PINS: usize = 10;

pub fn pins_storage_key(user_id: &str, conversation_id: &str) -> String {
    format!("pins.{user_id}.{conversation_id}")
}

pub fn parse_pins(raw: Option<&str>) -> Vec<String> {
    let Some(s) = raw else {
        return Vec::new();
    };
    let Ok(parsed) = serde_json::from_str::<Vec<serde_json::Value>>(s) else {
        return Vec::new();
    };
    let mut seen = HashSet::new();
    let mut out = Vec::new();
    for item in parsed {
        if let Some(key) = item.as_str() {
            if !key.is_empty() && seen.insert(key.to_string()) {
                out.push(key.to_string());
            }
        }
    }
    if out.len() > MAX_PINS {
        out.split_off(out.len() - MAX_PINS)
    } else {
        out
    }
}

pub fn can_pin(pins: &[String]) -> bool {
    pins.len() < MAX_PINS
}

pub fn add_pin(pins: &[String], key: &str) -> Vec<String> {
    if pins.iter().any(|x| x == key) || !can_pin(pins) {
        return pins.to_vec();
    }
    let mut out = pins.to_vec();
    out.push(key.to_string());
    out
}

pub fn remove_pin(pins: &[String], key: &str) -> Vec<String> {
    pins.iter().filter(|x| x.as_str() != key).cloned().collect()
}

pub fn prune_pins(pins: &[String], live_keys: &HashSet<String>) -> Vec<String> {
    pins.iter()
        .filter(|key| live_keys.contains(key.as_str()))
        .cloned()
        .collect()
}
