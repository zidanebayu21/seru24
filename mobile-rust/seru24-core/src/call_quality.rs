//! Kualitas suara telepon per percakapan (`web/shared/call-quality-core.ts`).

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum CallQuality {
    Hemat,
    #[default]
    Standar,
    Tinggi,
    Studio,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct CallQualityOption {
    pub value: CallQuality,
    pub label: &'static str,
    pub bitrate: u32,
}

pub const CALL_QUALITIES: [CallQualityOption; 4] = [
    CallQualityOption {
        value: CallQuality::Hemat,
        label: "Hemat data · 16 kbps",
        bitrate: 16_000,
    },
    CallQualityOption {
        value: CallQuality::Standar,
        label: "Standar · 32 kbps",
        bitrate: 32_000,
    },
    CallQualityOption {
        value: CallQuality::Tinggi,
        label: "Tinggi · 64 kbps",
        bitrate: 64_000,
    },
    CallQualityOption {
        value: CallQuality::Studio,
        label: "Studio · 128 kbps",
        bitrate: 128_000,
    },
];

impl CallQuality {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Hemat => "hemat",
            Self::Standar => "standar",
            Self::Tinggi => "tinggi",
            Self::Studio => "studio",
        }
    }

    pub fn option(self) -> CallQualityOption {
        CALL_QUALITIES
            .iter()
            .copied()
            .find(|o| o.value == self)
            .unwrap_or(CALL_QUALITIES[1])
    }

    pub fn parse(raw: Option<&str>) -> Self {
        match raw.unwrap_or_default() {
            "hemat" => Self::Hemat,
            "tinggi" => Self::Tinggi,
            "studio" => Self::Studio,
            _ => Self::Standar,
        }
    }

    pub fn next(self) -> Self {
        match self {
            Self::Hemat => Self::Standar,
            Self::Standar => Self::Tinggi,
            Self::Tinggi => Self::Studio,
            Self::Studio => Self::Hemat,
        }
    }
}

pub fn call_quality_key(conversation_id: &str) -> String {
    format!("seru24:call-quality:{conversation_id}")
}
