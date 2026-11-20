//! Jembatan platform Android (JNI ke `NativeBridge`) & fallback desktop (`seru24-app`).
//! Memisahkan panggilan native Android agar logika UI dan `seru24-core` tetap portabel.

use std::path::PathBuf;
use std::sync::{OnceLock, RwLock};

use seru24_core::call_core::IceCandidate;
use seru24_core::file::FileMessageBody;
use tokio::sync::mpsc;

#[derive(Debug, Clone)]
pub enum PlatformEvent {
    FcmToken(String),
    FilesPicked(Vec<PickedFile>),
    FileProgress {
        id: String,
        done: u64,
        total: u64,
    },
    NearbyEvent {
        kind: String,
        endpoint_id: String,
        value: String,
    },
    WebRtcOffer {
        sdp: String,
    },
    WebRtcAnswer {
        sdp: String,
    },
    WebRtcIce(IceCandidate),
    WebRtcConnectionState(String),
}

#[derive(Debug, Clone)]
pub struct PickedFile {
    pub uri: String,
    pub name: String,
    pub size: u64,
    pub mime: String,
}

static EVENT_TX: OnceLock<mpsc::UnboundedSender<PlatformEvent>> = OnceLock::new();
static DATA_DIR: RwLock<Option<PathBuf>> = RwLock::new(None);

pub fn install_event_channel(tx: mpsc::UnboundedSender<PlatformEvent>) {
    let _ = EVENT_TX.set(tx);
}

pub fn set_android_data_dir(dir: PathBuf) {
    if let Ok(mut guard) = DATA_DIR.write() {
        *guard = Some(dir);
    }
}

pub fn emit_platform_event(event: PlatformEvent) {
    if let Some(tx) = EVENT_TX.get() {
        let _ = tx.send(event);
    }
}

pub fn vault_db_path() -> PathBuf {
    if let Ok(guard) = DATA_DIR.read() {
        if let Some(ref p) = *guard {
            return p.join("seru24.sqlite");
        }
    }
    #[cfg(target_os = "windows")]
    if let Ok(local) = std::env::var("LOCALAPPDATA") {
        return PathBuf::from(local)
            .join("seru24-rust")
            .join("seru24.sqlite");
    }
    std::env::temp_dir()
        .join("seru24-rust")
        .join("seru24.sqlite")
}

pub fn device_display_name() -> String {
    #[cfg(target_os = "android")]
    {
        format!(
            "Android {}",
            android_bridge::device_label().unwrap_or_else(|| "SDK".to_string())
        )
    }
    #[cfg(not(target_os = "android"))]
    {
        "Desktop Windows".to_string()
    }
}

pub fn native_bridge_available() -> bool {
    #[cfg(target_os = "android")]
    {
        android_bridge::has_bridge()
    }
    #[cfg(not(target_os = "android"))]
    {
        false
    }
}

pub fn call_master_key() -> Option<[u8; 32]> {
    #[cfg(target_os = "android")]
    {
        android_bridge::get_or_create_master_key()
    }
    #[cfg(not(target_os = "android"))]
    {
        None
    }
}

pub fn show_notification(title: &str, body: &str, tag: &str) {
    #[cfg(target_os = "android")]
    android_bridge::call_void_3str("showNotification", title, body, tag);
    #[cfg(not(target_os = "android"))]
    let _ = (title, body, tag);
}

pub fn set_notification_presence(enabled: bool, foreground: bool, conversation_id: Option<&str>) {
    #[cfg(target_os = "android")]
    android_bridge::set_notify_presence(enabled, foreground, conversation_id.unwrap_or(""));
    #[cfg(not(target_os = "android"))]
    let _ = (enabled, foreground, conversation_id);
}

pub fn request_fcm_token() -> Option<String> {
    #[cfg(target_os = "android")]
    {
        android_bridge::call_str_0("requestFcmToken")
    }
    #[cfg(not(target_os = "android"))]
    {
        None
    }
}

pub fn request_pick_files() -> bool {
    #[cfg(target_os = "android")]
    {
        android_bridge::call_bool_0("pickFiles")
    }
    #[cfg(not(target_os = "android"))]
    {
        false
    }
}

pub fn save_text_to_downloads(name: &str, text: &str) -> Result<String, String> {
    #[cfg(target_os = "android")]
    if let Some(res) = android_bridge::call_str_2str("saveTextToDownloads", name, text) {
        return Ok(res);
    }
    let dir = vault_db_path()
        .parent()
        .map(PathBuf::from)
        .unwrap_or_else(std::env::temp_dir);
    let path = dir.join(name);
    std::fs::write(&path, text).map_err(|e| e.to_string())?;
    Ok(path.display().to_string())
}

pub fn encrypt_and_upload_file(
    uri: &str,
    attachment_id: &str,
    api_base: &str,
    token: &str,
) -> Result<(String, String), String> {
    #[cfg(target_os = "android")]
    if let Some(json) =
        android_bridge::call_str_4str("encryptAndUpload", uri, attachment_id, api_base, token)
    {
        let v: serde_json::Value = serde_json::from_str(&json).map_err(|e| e.to_string())?;
        if let Some(err) = v.get("error").and_then(|e| e.as_str()) {
            return Err(err.to_string());
        }
        let key = v
            .get("key")
            .and_then(|s| s.as_str())
            .ok_or_else(|| "key kosong".to_string())?
            .to_string();
        let iv = v
            .get("iv")
            .and_then(|s| s.as_str())
            .ok_or_else(|| "iv kosong".to_string())?
            .to_string();
        return Ok((key, iv));
    }
    let _ = (uri, attachment_id, api_base, token);
    Err("Modul unggah file Android belum tersedia".to_string())
}

pub fn download_and_save_file(
    file: &FileMessageBody,
    api_base: &str,
    token: &str,
) -> Result<String, String> {
    #[cfg(target_os = "android")]
    {
        let meta = serde_json::to_string(file).map_err(|e| e.to_string())?;
        if let Some(res) = android_bridge::call_str_3str("downloadAndSave", &meta, api_base, token)
        {
            if let Some(err) = res.strip_prefix("ERR:") {
                return Err(err.to_string());
            }
            return Ok(res);
        }
    }
    let _ = (file, api_base, token);
    Err("Modul unduh file Android belum tersedia".to_string())
}

pub fn open_saved_file(uri: &str, mime: &str) {
    #[cfg(target_os = "android")]
    android_bridge::call_void_2str("openFile", uri, mime);
    #[cfg(not(target_os = "android"))]
    let _ = (uri, mime);
}

pub fn play_voice_file(uri: &str) {
    #[cfg(target_os = "android")]
    android_bridge::call_void_1str("playVoice", uri);
    #[cfg(not(target_os = "android"))]
    let _ = uri;
}

pub fn nearby_start(endpoint_name: &str) -> Result<(), String> {
    #[cfg(target_os = "android")]
    if android_bridge::has_bridge() {
        if let Some(err) = android_bridge::call_str_1str("nearbyStart", endpoint_name) {
            if !err.is_empty() {
                return Err(err);
            }
            return Ok(());
        }
    }
    let _ = endpoint_name;
    Err("Siaran Dekat membutuhkan build Android Gradle dengan Play Services Nearby".to_string())
}

pub fn nearby_stop() {
    #[cfg(target_os = "android")]
    android_bridge::call_void_0("nearbyStop");
}

pub fn nearby_request(endpoint_id: &str, local_name: &str) {
    #[cfg(target_os = "android")]
    android_bridge::call_void_2str("nearbyRequest", endpoint_id, local_name);
    #[cfg(not(target_os = "android"))]
    let _ = (endpoint_id, local_name);
}

pub fn nearby_accept(endpoint_id: &str) {
    #[cfg(target_os = "android")]
    android_bridge::call_void_1str("nearbyAccept", endpoint_id);
    #[cfg(not(target_os = "android"))]
    let _ = endpoint_id;
}

pub fn nearby_reject(endpoint_id: &str) {
    #[cfg(target_os = "android")]
    android_bridge::call_void_1str("nearbyReject", endpoint_id);
    #[cfg(not(target_os = "android"))]
    let _ = endpoint_id;
}

pub fn nearby_send(endpoint_id: &str, payload: &str) {
    #[cfg(target_os = "android")]
    android_bridge::call_void_2str("nearbySend", endpoint_id, payload);
    #[cfg(not(target_os = "android"))]
    let _ = (endpoint_id, payload);
}

pub fn call_audio_begin() {
    #[cfg(target_os = "android")]
    android_bridge::call_void_0("callAudioBegin");
}

pub fn call_audio_set_speaker(on: bool) {
    #[cfg(target_os = "android")]
    android_bridge::call_void_bool("callAudioSpeaker", on);
    #[cfg(not(target_os = "android"))]
    let _ = on;
}

pub fn call_audio_end() {
    #[cfg(target_os = "android")]
    android_bridge::call_void_0("callAudioEnd");
}

pub fn webrtc_create_offer(bitrate: u32) -> bool {
    #[cfg(target_os = "android")]
    {
        android_bridge::call_bool_int("webrtcCreateOffer", bitrate as i32)
    }
    #[cfg(not(target_os = "android"))]
    {
        let _ = bitrate;
        false
    }
}

pub fn webrtc_handle_offer(sdp: &str, bitrate: u32) {
    #[cfg(target_os = "android")]
    android_bridge::call_void_str_int("webrtcHandleOffer", sdp, bitrate as i32);
    #[cfg(not(target_os = "android"))]
    let _ = (sdp, bitrate);
}

pub fn webrtc_handle_answer(sdp: &str) {
    #[cfg(target_os = "android")]
    android_bridge::call_void_1str("webrtcHandleAnswer", sdp);
    #[cfg(not(target_os = "android"))]
    let _ = sdp;
}

pub fn webrtc_add_ice(cand: &IceCandidate) {
    #[cfg(target_os = "android")]
    if let Ok(json) = serde_json::to_string(cand) {
        android_bridge::call_void_1str("webrtcAddIce", &json);
    }
    #[cfg(not(target_os = "android"))]
    let _ = cand;
}

pub fn webrtc_set_muted(muted: bool) {
    #[cfg(target_os = "android")]
    android_bridge::call_void_bool("webrtcSetMuted", muted);
    #[cfg(not(target_os = "android"))]
    let _ = muted;
}

pub fn webrtc_close() {
    #[cfg(target_os = "android")]
    android_bridge::call_void_0("webrtcClose");
}

pub fn download_and_install_update(url: &str, sha256: &str) -> Result<(), String> {
    #[cfg(target_os = "android")]
    if let Some(res) = android_bridge::call_str_2str("downloadAndInstallUpdate", url, sha256) {
        if res.is_empty() {
            return Ok(());
        }
        return Err(res);
    }
    let _ = (url, sha256);
    Err("Pembaruan APK hanya tersedia di build Android".to_string())
}

pub fn open_url(url: &str) {
    #[cfg(target_os = "android")]
    android_bridge::call_void_1str("openUrl", url);
    #[cfg(not(target_os = "android"))]
    let _ = url;
}

pub fn is_system_dark_mode() -> bool {
    #[cfg(target_os = "android")]
    {
        android_bridge::call_bool_0("isSystemDarkMode")
    }
    #[cfg(not(target_os = "android"))]
    {
        false
    }
}

pub fn read_text_uri(uri: &str) -> Option<String> {
    #[cfg(target_os = "android")]
    {
        android_bridge::call_str_1str("readTextUri", uri)
    }
    #[cfg(not(target_os = "android"))]
    {
        let _ = uri;
        None
    }
}

#[cfg(target_os = "android")]
mod android_bridge {
    use jni::errors::LogErrorAndDefault;
    use jni::objects::{JClass, JObject, JString, JValue, JValueOwned};
    use jni::signature::{RuntimeFieldSignature, RuntimeMethodSignature};
    use jni::strings::JNIString;
    use jni::sys::jlong;
    use jni::{jni_str, Env, EnvUnowned, JavaVM};
    use seru24_core::call_core::IceCandidate;
    use seru24_core::crypto::{as_key_array, from_base64};

    use super::{emit_platform_event, PickedFile, PlatformEvent};

    const BRIDGE_CLASS: &str = "id/seru24/chat/rust/NativeBridge";

    fn with_env<T>(f: impl FnOnce(&mut Env<'_>, &JObject<'_>) -> Option<T>) -> Option<T> {
        let ctx = ndk_context::android_context();
        let vm = unsafe { JavaVM::from_raw(ctx.vm().cast()) };
        vm.attach_current_thread(|env| -> jni::errors::Result<Option<T>> {
            let activity = unsafe { JObject::from_raw(env, ctx.context().cast()) };
            Ok(f(env, &activity))
        })
        .ok()
        .flatten()
    }

    fn find_bridge_class<'a>(env: &mut Env<'a>) -> Option<JClass<'a>> {
        let cls_name = JNIString::new(BRIDGE_CLASS);
        match env.find_class(&cls_name) {
            Ok(cls) => Some(cls),
            Err(_) => {
                env.exception_clear();
                None
            }
        }
    }

    fn call_static<'a>(
        env: &mut Env<'a>,
        method: &str,
        sig: &str,
        args: &[JValue<'_>],
    ) -> Option<JValueOwned<'a>> {
        let cls = find_bridge_class(env)?;
        let m = JNIString::new(method);
        let s = RuntimeMethodSignature::from_str(sig).ok()?;
        match env.call_static_method(cls, &m, s.method_signature(), args) {
            Ok(v) => Some(v),
            Err(_) => {
                env.exception_clear();
                None
            }
        }
    }

    fn extract_opt_string(env: &mut Env<'_>, val: JValueOwned<'_>) -> Option<String> {
        let obj = val.l().ok()?;
        if obj.is_null() {
            return None;
        }
        let jstr = unsafe { JString::from_raw(env, obj.into_raw().cast()) };
        jstr.try_to_string(env).ok()
    }

    pub fn has_bridge() -> bool {
        with_env(|env, _| find_bridge_class(env).map(|_| ())).is_some()
    }

    pub fn device_label() -> Option<String> {
        Some(android_os_release())
    }

    fn android_os_release() -> String {
        with_env(|env, _| {
            let cls = env.find_class(jni_str!("android/os/Build$VERSION")).ok()?;
            let fsig = RuntimeFieldSignature::from_str("Ljava/lang/String;").ok()?;
            let rel = env
                .get_static_field(cls, jni_str!("RELEASE"), fsig.field_signature())
                .ok()?
                .l()
                .ok()?;
            if rel.is_null() {
                return None;
            }
            let jstr = unsafe { JString::from_raw(env, rel.into_raw().cast()) };
            jstr.try_to_string(env).ok()
        })
        .unwrap_or_else(|| "Device".to_string())
    }

    pub fn get_or_create_master_key() -> Option<[u8; 32]> {
        let b64 = call_str_0("getOrCreateMasterKey")?;
        let raw = from_base64(b64.trim()).ok()?;
        as_key_array(&raw).ok()
    }

    pub fn set_notify_presence(enabled: bool, foreground: bool, conv_id: &str) {
        let _ = with_env(|env, act| {
            let jconv = env.new_string(conv_id).ok()?;
            let _ = call_static(
                env,
                "setNotifyPresence",
                "(Landroid/content/Context;ZZLjava/lang/String;)V",
                &[
                    JValue::Object(act),
                    JValue::Bool(enabled),
                    JValue::Bool(foreground),
                    JValue::Object(jconv.as_ref()),
                ],
            )?;
            Some(())
        });
    }

    fn call_void_strs(method: &str, strs: &[&str]) {
        let _ = with_env(|env, act| {
            let sig = format!(
                "(Landroid/content/Context;{})V",
                "Ljava/lang/String;".repeat(strs.len())
            );
            let mut jstrs = Vec::with_capacity(strs.len());
            for s in strs {
                jstrs.push(env.new_string(s).ok()?);
            }
            let mut args = Vec::with_capacity(1 + strs.len());
            args.push(JValue::Object(act));
            for js in &jstrs {
                args.push(JValue::Object(js.as_ref()));
            }
            call_static(env, method, &sig, &args)?;
            Some(())
        });
    }

    fn call_str_strs(method: &str, strs: &[&str]) -> Option<String> {
        with_env(|env, act| {
            let sig = format!(
                "(Landroid/content/Context;{})Ljava/lang/String;",
                "Ljava/lang/String;".repeat(strs.len())
            );
            let mut jstrs = Vec::with_capacity(strs.len());
            for s in strs {
                jstrs.push(env.new_string(s).ok()?);
            }
            let mut args = Vec::with_capacity(1 + strs.len());
            args.push(JValue::Object(act));
            for js in &jstrs {
                args.push(JValue::Object(js.as_ref()));
            }
            let res = call_static(env, method, &sig, &args)?;
            extract_opt_string(env, res)
        })
    }

    pub fn call_void_0(method: &str) {
        call_void_strs(method, &[]);
    }

    pub fn call_void_bool(method: &str, v: bool) {
        let _ = with_env(|env, act| {
            call_static(
                env,
                method,
                "(Landroid/content/Context;Z)V",
                &[JValue::Object(act), JValue::Bool(v)],
            )?;
            Some(())
        });
    }

    pub fn call_void_1str(method: &str, a: &str) {
        call_void_strs(method, &[a]);
    }

    pub fn call_void_str_int(method: &str, a: &str, b: i32) {
        let _ = with_env(|env, act| {
            let ja = env.new_string(a).ok()?;
            call_static(
                env,
                method,
                "(Landroid/content/Context;Ljava/lang/String;I)V",
                &[
                    JValue::Object(act),
                    JValue::Object(ja.as_ref()),
                    JValue::Int(b),
                ],
            )?;
            Some(())
        });
    }

    pub fn call_void_2str(method: &str, a: &str, b: &str) {
        call_void_strs(method, &[a, b]);
    }

    pub fn call_void_3str(method: &str, a: &str, b: &str, c: &str) {
        call_void_strs(method, &[a, b, c]);
    }

    pub fn call_bool_0(method: &str) -> bool {
        with_env(|env, act| {
            call_static(
                env,
                method,
                "(Landroid/content/Context;)Z",
                &[JValue::Object(act)],
            )?
            .z()
            .ok()
        })
        .unwrap_or(false)
    }

    pub fn call_bool_int(method: &str, v: i32) -> bool {
        with_env(|env, act| {
            call_static(
                env,
                method,
                "(Landroid/content/Context;I)Z",
                &[JValue::Object(act), JValue::Int(v)],
            )?
            .z()
            .ok()
        })
        .unwrap_or(false)
    }

    pub fn call_str_0(method: &str) -> Option<String> {
        call_str_strs(method, &[])
    }

    pub fn call_str_1str(method: &str, a: &str) -> Option<String> {
        call_str_strs(method, &[a])
    }

    pub fn call_str_2str(method: &str, a: &str, b: &str) -> Option<String> {
        call_str_strs(method, &[a, b])
    }

    pub fn call_str_3str(method: &str, a: &str, b: &str, c: &str) -> Option<String> {
        call_str_strs(method, &[a, b, c])
    }

    pub fn call_str_4str(method: &str, a: &str, b: &str, c: &str, d: &str) -> Option<String> {
        call_str_strs(method, &[a, b, c, d])
    }

    fn read_str(unowned: &mut EnvUnowned<'_>, s: &JString<'_>) -> String {
        unowned
            .with_env(|env| -> jni::errors::Result<String> { s.try_to_string(env) })
            .resolve::<LogErrorAndDefault>()
    }

    #[no_mangle]
    pub extern "C" fn Java_id_seru24_chat_rust_NativeBridge_onFcmToken<'local>(
        mut env: EnvUnowned<'local>,
        _cls: JClass<'local>,
        token: JString<'local>,
    ) {
        let tok = read_str(&mut env, &token);
        if !tok.is_empty() {
            emit_platform_event(PlatformEvent::FcmToken(tok));
        }
    }

    #[no_mangle]
    pub extern "C" fn Java_id_seru24_chat_rust_NativeBridge_onFilesPicked<'local>(
        mut env: EnvUnowned<'local>,
        _cls: JClass<'local>,
        json_array: JString<'local>,
    ) {
        let raw = read_str(&mut env, &json_array);
        if let Ok(items) = serde_json::from_str::<Vec<serde_json::Value>>(&raw) {
            let picked = items
                .into_iter()
                .filter_map(|v| {
                    Some(PickedFile {
                        uri: v.get("uri")?.as_str()?.to_string(),
                        name: v.get("name")?.as_str()?.to_string(),
                        size: v.get("size")?.as_u64()?,
                        mime: v
                            .get("mime")
                            .and_then(|m| m.as_str())
                            .unwrap_or("application/octet-stream")
                            .to_string(),
                    })
                })
                .collect();
            emit_platform_event(PlatformEvent::FilesPicked(picked));
        }
    }

    #[no_mangle]
    pub extern "C" fn Java_id_seru24_chat_rust_NativeBridge_onFileProgress<'local>(
        mut env: EnvUnowned<'local>,
        _cls: JClass<'local>,
        id: JString<'local>,
        done: jlong,
        total: jlong,
    ) {
        emit_platform_event(PlatformEvent::FileProgress {
            id: read_str(&mut env, &id),
            done: done.max(0) as u64,
            total: total.max(0) as u64,
        });
    }

    #[no_mangle]
    pub extern "C" fn Java_id_seru24_chat_rust_NativeBridge_onNearbyEvent<'local>(
        mut env: EnvUnowned<'local>,
        _cls: JClass<'local>,
        kind: JString<'local>,
        endpoint_id: JString<'local>,
        value: JString<'local>,
    ) {
        emit_platform_event(PlatformEvent::NearbyEvent {
            kind: read_str(&mut env, &kind),
            endpoint_id: read_str(&mut env, &endpoint_id),
            value: read_str(&mut env, &value),
        });
    }

    #[no_mangle]
    pub extern "C" fn Java_id_seru24_chat_rust_NativeBridge_onWebRtcOffer<'local>(
        mut env: EnvUnowned<'local>,
        _cls: JClass<'local>,
        sdp: JString<'local>,
    ) {
        emit_platform_event(PlatformEvent::WebRtcOffer {
            sdp: read_str(&mut env, &sdp),
        });
    }

    #[no_mangle]
    pub extern "C" fn Java_id_seru24_chat_rust_NativeBridge_onWebRtcAnswer<'local>(
        mut env: EnvUnowned<'local>,
        _cls: JClass<'local>,
        sdp: JString<'local>,
    ) {
        emit_platform_event(PlatformEvent::WebRtcAnswer {
            sdp: read_str(&mut env, &sdp),
        });
    }

    #[no_mangle]
    pub extern "C" fn Java_id_seru24_chat_rust_NativeBridge_onWebRtcIce<'local>(
        mut env: EnvUnowned<'local>,
        _cls: JClass<'local>,
        json: JString<'local>,
    ) {
        let raw = read_str(&mut env, &json);
        if let Ok(cand) = serde_json::from_str::<IceCandidate>(&raw) {
            emit_platform_event(PlatformEvent::WebRtcIce(cand));
        }
    }

    #[no_mangle]
    pub extern "C" fn Java_id_seru24_chat_rust_NativeBridge_onWebRtcState<'local>(
        mut env: EnvUnowned<'local>,
        _cls: JClass<'local>,
        state: JString<'local>,
    ) {
        emit_platform_event(PlatformEvent::WebRtcConnectionState(read_str(
            &mut env, &state,
        )));
    }
}
