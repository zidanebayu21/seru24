//! Konfigurasi publik server (`build.rs` menyalin dari `mobile/.env` / env saat build, tanpa hardcode di git).

#[derive(Debug, Clone)]
pub struct AppEnv {
    pub supabase_url: String,
    pub supabase_anon_key: String,
    pub api_base_url: String,
    pub password_min_length: usize,
}

impl AppEnv {
    pub fn from_build() -> Self {
        let min_len = option_env!("SERU24_PASSWORD_MIN_LENGTH")
            .and_then(|s| s.parse::<usize>().ok())
            .filter(|&n| n >= 8)
            .unwrap_or(12);
        Self {
            supabase_url: option_env!("SERU24_SUPABASE_URL")
                .unwrap_or_default()
                .trim_end_matches('/')
                .to_string(),
            supabase_anon_key: option_env!("SERU24_SUPABASE_ANON_KEY")
                .unwrap_or_default()
                .to_string(),
            api_base_url: option_env!("SERU24_API_BASE_URL")
                .filter(|s| !s.is_empty())
                .unwrap_or("https://seru24.vercel.app")
                .trim_end_matches('/')
                .to_string(),
            password_min_length: min_len,
        }
    }

    pub fn is_configured(&self) -> bool {
        !self.supabase_url.is_empty() && !self.supabase_anon_key.is_empty()
    }
}
