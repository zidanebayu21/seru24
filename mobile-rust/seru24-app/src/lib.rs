slint::include_modules!();

pub mod controller;
pub mod platform;

pub use controller::initials_of;

#[cfg(target_os = "android")]
fn register_android_emoji_fallbacks() {
    use slint::fontique_012::fontique::{FallbackKey, GenericFamily, Script};

    let mut collection = slint::fontique_012::shared_collection();
    let existing: Vec<_> = collection.generic_families(GenericFamily::Emoji).collect();
    let mut additions = Vec::new();

    for name in ["Noto Color Emoji", "Noto Color Emoji Flags"] {
        if let Some(id) = collection.family_id(name) {
            if !existing.contains(&id) && !additions.contains(&id) {
                additions.push(id);
            }
        }
    }

    // Jika `fontique` Android melewati `<family lang="und-Zsye">` tanpa postScriptName,
    // muat font bendera sistem langsung agar ukuran APK tetap kecil.
    if collection.family_id("Noto Color Emoji Flags").is_none() {
        if let Ok(bytes) = std::fs::read("/system/fonts/NotoColorEmojiFlags.ttf") {
            let registered = collection.register_fonts(bytes.into(), None);
            for (id, _) in registered {
                if !existing.contains(&id) && !additions.contains(&id) {
                    additions.push(id);
                }
            }
        }
    }

    if !additions.is_empty() {
        collection.append_generic_families(GenericFamily::Emoji, additions.iter().copied());
        let zsye = FallbackKey::new(Script::from_bytes(*b"Zsye"), None);
        collection.append_fallbacks(zsye, additions.iter().copied());
    }
}

/// Menjalankan UI utama Slint (dipakai bersama oleh desktop `main` dan Android `android_main`).
pub fn run_app() {
    let window = MainWindow::new().expect("gagal membuat MainWindow Slint");
    #[cfg(target_os = "android")]
    register_android_emoji_fallbacks();

    controller::start_ui(&window);
    window.run().expect("event loop Slint gagal berjalan");
}

// Kompatibilitas NDK 27: biner prabangun `skia-bindings 0.157.0` memakai `std::__ndk1::__hash_memory`
// (baru tersedia di libc++ NDK 28+). Implementasi FNV-1a 64-bit ini hanya aktif di Android agar
// `libskia.a` dapat dimuat oleh linker Android pada NDK 27.1.12297006.
#[cfg(target_os = "android")]
#[export_name = "_ZNSt6__ndk113__hash_memoryEPKvm"]
pub extern "C" fn ndk_compat_hash_memory(ptr: *const u8, len: usize) -> usize {
    if ptr.is_null() || len == 0 {
        return 0xcbf2_9ce4_8422_2325_u64 as usize;
    }
    // SAFETY: Pemanggil (`std::__ndk1::__hash_memory` di libc++ / libskia) menjamin `ptr` valid
    // untuk dibaca sepanjang `len` byte selama pemanggilan ini.
    let bytes = unsafe { std::slice::from_raw_parts(ptr, len) };
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for &b in bytes {
        hash ^= u64::from(b);
        hash = hash.wrapping_mul(0x0100_0000_01b3);
    }
    hash as usize
}

#[cfg(target_os = "android")]
#[no_mangle]
pub fn android_main(app: slint::android::AndroidApp) {
    if let Some(dir) = app.internal_data_path() {
        platform::set_android_data_dir(dir);
    }
    slint::android::init(app).expect("gagal inisialisasi backend Android Slint");
    run_app();
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn initials_handles_one_two_and_empty_names() {
        assert_eq!(initials_of("Rina Putri"), "RP");
        assert_eq!(initials_of("Zidane"), "Z");
        assert_eq!(initials_of("   "), "?");
    }
}
