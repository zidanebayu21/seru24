use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;

fn parse_dotenv(path: &PathBuf) -> HashMap<String, String> {
    let mut map = HashMap::new();
    let Ok(raw) = fs::read_to_string(path) else {
        return map;
    };
    for line in raw.lines() {
        let clean = line.trim_start_matches('\u{feff}').trim();
        if clean.is_empty() || clean.starts_with('#') {
            continue;
        }
        if let Some((k, v)) = clean.split_once('=') {
            map.insert(k.trim().to_string(), v.trim().to_string());
        }
    }
    map
}

fn main() {
    let manifest_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let mobile_env = manifest_dir
        .join("..")
        .join("..")
        .join("mobile")
        .join(".env");
    println!("cargo:rerun-if-changed={}", mobile_env.display());

    let dotenv = parse_dotenv(&mobile_env);
    let keys = [
        ("SERU24_SUPABASE_URL", "SUPABASE_URL", ""),
        ("SERU24_SUPABASE_ANON_KEY", "SUPABASE_ANON_KEY", ""),
        (
            "SERU24_API_BASE_URL",
            "API_BASE_URL",
            "https://seru24.vercel.app",
        ),
        ("SERU24_PASSWORD_MIN_LENGTH", "PASSWORD_MIN_LENGTH", "12"),
    ];

    for (rust_key, env_key, fallback) in keys {
        println!("cargo:rerun-if-env-changed={rust_key}");
        println!("cargo:rerun-if-env-changed={env_key}");
        let val = std::env::var(rust_key)
            .ok()
            .filter(|s| !s.is_empty())
            .or_else(|| std::env::var(env_key).ok().filter(|s| !s.is_empty()))
            .or_else(|| dotenv.get(env_key).cloned().filter(|s| !s.is_empty()))
            .unwrap_or_else(|| fallback.to_string());
        println!("cargo:rustc-env={rust_key}={val}");
    }
}
