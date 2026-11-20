//! Info & validasi rilis APK Android terbaru (`web/shared/app-release.ts`, OWASP ASVS V10.3.2).

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppRelease {
    pub version_code: u64,
    pub version_name: String,
    pub url: String,
    pub download_url: String,
    pub sha256: String,
    pub size_bytes: u64,
    pub updated_at: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub variant: Option<String>,
}

fn valid_id_segment(s: &str) -> bool {
    (10..=100).contains(&s.len())
        && s.bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}

fn valid_drive_view(url: &str) -> bool {
    let Some(rest) = url.strip_prefix("https://drive.google.com/file/d/") else {
        return false;
    };
    let Some(id) = rest.strip_suffix("/view") else {
        return false;
    };
    valid_id_segment(id)
}

fn valid_drive_download(url: &str) -> bool {
    let Some(rest) = url.strip_prefix("https://drive.usercontent.google.com/download?id=") else {
        return false;
    };
    let Some(id) = rest.strip_suffix("&export=download&confirm=t") else {
        return false;
    };
    valid_id_segment(id)
}

fn valid_sha256_hex(s: &str) -> bool {
    s.len() == 64
        && s.bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

fn valid_version_name(s: &str) -> bool {
    (1..=20).contains(&s.len())
        && s.bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'.' || b == b'-' || b == b'_')
}

pub fn drive_links(file_id: &str) -> (String, String) {
    (
        format!("https://drive.google.com/file/d/{file_id}/view"),
        format!(
            "https://drive.usercontent.google.com/download?id={file_id}&export=download&confirm=t"
        ),
    )
}

pub fn parse_app_release(value: &serde_json::Value) -> Option<AppRelease> {
    let obj = value.as_object()?;
    let version_code = obj.get("versionCode")?.as_u64()?;
    let version_name = obj.get("versionName")?.as_str()?;
    let url = obj.get("url")?.as_str()?;
    let download_url = obj.get("downloadUrl")?.as_str()?;
    let sha256 = obj.get("sha256")?.as_str()?;
    let variant = match obj.get("variant") {
        None | Some(serde_json::Value::Null) => None,
        Some(serde_json::Value::String(s)) if s == "react" || s == "rust" => Some(s.clone()),
        _ => return None,
    };
    if version_code < 1
        || !valid_version_name(version_name)
        || !valid_drive_view(url)
        || !valid_drive_download(download_url)
        || !valid_sha256_hex(sha256)
    {
        return None;
    }
    Some(AppRelease {
        version_code,
        version_name: version_name.to_string(),
        url: url.to_string(),
        download_url: download_url.to_string(),
        sha256: sha256.to_string(),
        size_bytes: obj.get("sizeBytes").and_then(|v| v.as_u64()).unwrap_or(0),
        updated_at: obj
            .get("updatedAt")
            .and_then(|v| v.as_str())
            .unwrap_or_default()
            .to_string(),
        variant,
    })
}

pub fn is_newer_release(latest: Option<&AppRelease>, current_version_code: u64) -> bool {
    latest
        .map(|r| r.version_code > current_version_code)
        .unwrap_or(false)
}

/// Pastikan pembaruan hanya ditawarkan bila payload berasal dari kanal `rust` (`?app=rust`),
/// sehingga respons server lama (`android_apk` React Native) tidak memicu unduhan APK yang keliru.
pub fn is_newer_rust_release(latest: Option<&AppRelease>, current_version_code: u64) -> bool {
    latest
        .map(|r| r.variant.as_deref() == Some("rust") && r.version_code > current_version_code)
        .unwrap_or(false)
}
