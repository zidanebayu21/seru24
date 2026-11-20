//! Logika UI akun/backup/update, Siaran Dekat (Nearby), dan panggilan suara 1-1.

use std::rc::Rc;
use std::sync::Arc;

use serde_json::json;
use seru24_core::backup::{
    group_messages_by_conversation, merge_conversations, open_backup, seal_backup, BackupData,
};
use seru24_core::call_core::{
    CallAction, CallEndReason, CallPhase, CallSignal, CALL_RING_TIMEOUT_MS,
};
use seru24_core::chat::{now_iso_utc, ListConversationsOptions};
use seru24_core::crypto::{random_id, PartyKey};
use seru24_core::e2ee::{ChatMessage, SealTarget};
use seru24_core::file::FILE_TAG_BYTES;
use seru24_core::nearby::{
    build_endpoint_name, contact_tag, encode_nearby_ack, encode_nearby_hello,
    encode_nearby_message, parse_endpoint_name, parse_nearby_wire, random_alias, should_initiate,
    EndpointName, NearbyHello, NearbySendParams, NearbyWire,
};
use slint::{ComponentHandle, ModelRc, SharedString, VecModel, Weak};
use tokio::runtime::Runtime;
use tokio::sync::Mutex;

use crate::controller::chat_ctrl::{apply_incoming_message, open_conversation};
use crate::controller::{
    avatar_color, initials_of, on_ui, refresh_chat_list_ui, sync_profile_header, AppState,
};
use crate::platform::{self, PlatformEvent};
use crate::{MainWindow, NearbyMsgItem, NearbyPeerItem};

pub(crate) fn wire_extra_callbacks(
    window: &MainWindow,
    rt: &Arc<Runtime>,
    state: &Arc<Mutex<AppState>>,
) {
    // Account screen navigation & actions
    let weak = window.as_weak();
    let rt_c = rt.clone();
    let st_c = state.clone();
    window.on_open_account(move || {
        let w = weak.clone();
        let s = st_c.clone();
        rt_c.spawn(async move {
            let stats_lbl = {
                let g = s.lock().await;
                let uid = g.client.me.as_ref().map(|m| m.id.as_str()).unwrap_or("");
                match g.client.vault.stats(uid) {
                    Ok(st) => {
                        let size = st
                            .size_bytes
                            .map(|b| format!(" · {:.1} KB", b as f64 / 1024.0))
                            .unwrap_or_default();
                        format!(
                            "{} percakapan · {} pesan{}",
                            st.conversations, st.messages, size
                        )
                    }
                    Err(_) => "0 percakapan · 0 pesan".to_string(),
                }
            };
            on_ui(&w, move |ui| {
                ui.set_storage_stats(stats_lbl.into());
                ui.set_account_notice(SharedString::default());
                ui.set_account_error(SharedString::default());
                ui.set_account_menu_open(true);
            });
        });
    });

    let weak = window.as_weak();
    let rt_c = rt.clone();
    let st_c = state.clone();
    window.on_save_profile(move |raw_name| {
        let w = weak.clone();
        let s = st_c.clone();
        let trimmed = raw_name.trim().to_string();
        if trimmed.chars().count() > 50 {
            if let Some(ui) = weak.upgrade() {
                ui.set_account_error("Nama tampil maksimal 50 karakter.".into());
            }
            return;
        }
        on_ui(&w, |ui| {
            ui.set_account_busy(true);
            ui.set_account_error(SharedString::default());
            ui.set_account_notice(SharedString::default());
        });
        rt_c.spawn(async move {
            let rpc = { s.lock().await.client.rpc.clone() };
            match rpc.update_profile(&trimmed).await {
                Ok(saved_name) => {
                    {
                        let mut g = s.lock().await;
                        if let Some(ref mut me) = g.client.me {
                            me.display_name = saved_name;
                        }
                        g.client.remember_me();
                    }
                    sync_profile_header(&w, &s).await;
                    on_ui(&w, |ui| {
                        ui.set_account_busy(false);
                        ui.set_account_notice("Profil diperbarui.".into());
                    });
                }
                Err(e) => {
                    let msg = e.user_message("Gagal memperbarui profil.");
                    on_ui(&w, move |ui| {
                        ui.set_account_busy(false);
                        ui.set_account_error(msg.into());
                    });
                }
            }
        });
    });

    let weak = window.as_weak();
    let rt_c = rt.clone();
    let st_c = state.clone();
    window.on_export_backup(move || {
        let w = weak.clone();
        let s = st_c.clone();
        rt_c.spawn(async move {
            let (my_id, ring, vault) = {
                let g = s.lock().await;
                (
                    g.client
                        .me
                        .as_ref()
                        .map(|m| m.id.clone())
                        .unwrap_or_default(),
                    g.client.keyring.clone(),
                    g.client.vault.clone(),
                )
            };
            let Some(ring) = ring else { return };
            let conversations = vault.load_conversations(&my_id).unwrap_or_default();
            let mut messages: Vec<ChatMessage> = Vec::new();
            for c in &conversations {
                if let Ok(st) = vault.load_conversation_state(&my_id, &c.id) {
                    messages.extend(st.messages);
                }
            }
            let data = BackupData {
                exported_at: now_iso_utc(),
                conversations,
                messages,
            };
            match seal_backup(&ring, &my_id, &data) {
                Ok(text) => {
                    let filename = format!("seru24-cadangan-{}.txt", &data.exported_at[..10]);
                    match platform::save_text_to_downloads(&filename, &text) {
                        Ok(dest) => {
                            let msg = format!("Cadangan tersimpan di {dest}");
                            on_ui(&w, move |ui| ui.set_account_notice(msg.into()));
                        }
                        Err(e) => {
                            on_ui(&w, move |ui| ui.set_account_error(e.into()));
                        }
                    }
                }
                Err(e) => {
                    let msg = e.to_string();
                    on_ui(&w, move |ui| ui.set_account_error(msg.into()));
                }
            }
        });
    });

    let weak = window.as_weak();
    let rt_c = rt.clone();
    let st_c = state.clone();
    window.on_import_backup(move || {
        let w = weak.clone();
        let s = st_c.clone();
        rt_c.spawn(async move {
            if platform::native_bridge_available() {
                s.lock().await.pending_backup_import = true;
                if platform::request_pick_files() {
                    return;
                }
                s.lock().await.pending_backup_import = false;
            }
            let (my_id, ring, vault) = {
                let g = s.lock().await;
                (
                    g.client
                        .me
                        .as_ref()
                        .map(|m| m.id.clone())
                        .unwrap_or_default(),
                    g.client.keyring.clone(),
                    g.client.vault.clone(),
                )
            };
            let Some(ring) = ring else { return };
            let dir = platform::vault_db_path()
                .parent()
                .map(|p| p.to_path_buf())
                .unwrap_or_else(std::env::temp_dir);
            let candidate = std::fs::read_dir(&dir).ok().and_then(|rd| {
                rd.filter_map(Result::ok).find(|e| {
                    e.file_name()
                        .to_string_lossy()
                        .starts_with("seru24-cadangan-")
                })
            });
            let Some(file) = candidate else {
                on_ui(&w, |ui| {
                    ui.set_account_error(
                        "Taruh file seru24-cadangan-*.txt di folder aplikasi untuk impor.".into(),
                    );
                });
                return;
            };
            let Ok(raw) = std::fs::read_to_string(file.path()) else {
                return;
            };
            apply_backup_import(&w, &s, &vault, &ring, &my_id, &raw).await;
        });
    });

    let weak = window.as_weak();
    let rt_c = rt.clone();
    let st_c = state.clone();
    window.on_clear_cache(move || {
        let w = weak.clone();
        let s = st_c.clone();
        rt_c.spawn(async move {
            {
                let mut g = s.lock().await;
                let uid = g
                    .client
                    .me
                    .as_ref()
                    .map(|m| m.id.clone())
                    .unwrap_or_default();
                let _ = g.client.vault.clear_all_chats(&uid);
                g.conversations.clear();
            }
            refresh_chat_list_ui(&w, &s).await;
            on_ui(&w, |ui| {
                ui.set_storage_stats("0 percakapan · 0 pesan".into());
                ui.set_account_notice("Cache chat lokal dibersihkan.".into());
            });
        });
    });

    let weak = window.as_weak();
    let rt_c = rt.clone();
    let st_c = state.clone();
    window.on_reset_full_db(move || {
        let w = weak.clone();
        let s = st_c.clone();
        rt_c.spawn(async move {
            {
                let mut g = s.lock().await;
                let uid = g
                    .client
                    .me
                    .as_ref()
                    .map(|m| m.id.clone())
                    .unwrap_or_default();
                let _ = g.client.vault.clear_all_chats(&uid);
                g.conversations.clear();
                g.all_messages.clear();
                g.bubbles.clear();
            }
            refresh_chat_list_ui(&w, &s).await;
            on_ui(&w, |ui| {
                ui.set_storage_stats("0 percakapan · 0 pesan".into());
                ui.set_account_notice("Database chat lokal direset penuh.".into());
            });
        });
    });

    let weak = window.as_weak();
    let rt_c = rt.clone();
    let st_c = state.clone();
    window.on_change_password(move || {
        let Some(ui) = weak.upgrade() else { return };
        let old_pw = ui.get_old_password().to_string();
        let new_pw = ui.get_new_password().to_string();
        let w = weak.clone();
        let s = st_c.clone();
        rt_c.spawn(async move {
            let (min_len, me_opt, ring_opt, session) = {
                let g = s.lock().await;
                (
                    g.client.env.password_min_length,
                    g.client.me.clone(),
                    g.client.keyring.clone(),
                    g.client.session.clone(),
                )
            };
            if new_pw.chars().count() < min_len {
                on_ui(&w, move |u| {
                    u.set_account_error(format!("Password baru minimal {min_len} karakter").into());
                });
                return;
            }
            let (Some(me), Some(ring)) = (me_opt, ring_opt) else {
                return;
            };
            on_ui(&w, |u| {
                u.set_account_busy(true);
                u.set_account_error(SharedString::default());
                u.set_account_notice(SharedString::default());
            });
            match session
                .change_password(&me.username, &old_pw, &new_pw, &ring, &me.id)
                .await
            {
                Ok(()) => {
                    on_ui(&w, |u| {
                        u.set_account_busy(false);
                        u.set_old_password(SharedString::default());
                        u.set_new_password(SharedString::default());
                        u.set_account_notice(
                            "Password diperbarui. Kunci chat & pesan lama tetap terjaga.".into(),
                        );
                    });
                }
                Err(e) => {
                    let msg = e.user_message("Gagal memperbarui password.");
                    on_ui(&w, move |u| {
                        u.set_account_busy(false);
                        u.set_account_error(msg.into());
                    });
                }
            }
        });
    });

    let weak = window.as_weak();
    let rt_c = rt.clone();
    let st_c = state.clone();
    window.on_toggle_notify(move |on| {
        let w = weak.clone();
        let s = st_c.clone();
        rt_c.spawn(async move {
            let rpc = {
                let mut g = s.lock().await;
                g.notify_enabled = on;
                let _ = g
                    .client
                    .vault
                    .set_secret("notifications", if on { "on" } else { "off" });
                g.client.rpc.clone()
            };
            platform::set_notification_presence(on, true, None);
            if on {
                if let Some(tok) = platform::request_fcm_token() {
                    let _ = rpc.register_push_token("android", &tok).await;
                }
            }
            on_ui(&w, move |ui| ui.set_notify_enabled(on));
        });
    });

    let weak = window.as_weak();
    let rt_c = rt.clone();
    let st_c = state.clone();
    window.on_sign_out(move || {
        let w = weak.clone();
        let s = st_c.clone();
        rt_c.spawn(async move {
            {
                let mut g = s.lock().await;
                if let Some(rt) = g.realtime.take() {
                    rt.shutdown();
                }
                g.e2ee.reset();
                g.conversations.clear();
                g.client.sign_out().await;
            }
            platform::set_notification_presence(false, false, None);
            on_ui(&w, |ui| {
                ui.set_account_menu_open(false);
                ui.set_screen("auth".into());
                ui.set_chats(ModelRc::from(Rc::new(VecModel::from(Vec::new()))));
                ui.set_messages(ModelRc::from(Rc::new(VecModel::from(Vec::new()))));
            });
        });
    });

    // Nearby screens
    let weak = window.as_weak();
    let rt_c = rt.clone();
    let st_c = state.clone();
    window.on_open_nearby(move || {
        let w = weak.clone();
        let s = st_c.clone();
        rt_c.spawn(async move {
            let supported = platform::native_bridge_available();
            let peers = s.lock().await.nearby_peers.clone();
            on_ui(&w, move |ui| {
                ui.set_radar_supported(supported);
                ui.set_nearby_peers(ModelRc::from(Rc::new(VecModel::from(peers))));
                ui.set_screen("nearby".into());
            });
        });
    });

    let weak = window.as_weak();
    let rt_c = rt.clone();
    let st_c = state.clone();
    window.on_toggle_radar(move |on| {
        let w = weak.clone();
        let s = st_c.clone();
        rt_c.spawn(async move {
            if !on {
                platform::nearby_stop();
                let mut g = s.lock().await;
                g.radar_on = false;
                g.nearby_peers.clear();
                on_ui(&w, |ui| {
                    ui.set_radar_on(false);
                    ui.set_nearby_peers(ModelRc::from(Rc::new(VecModel::from(Vec::new()))));
                });
                return;
            }
            let (my_id, convs) = {
                let g = s.lock().await;
                (
                    g.client
                        .me
                        .as_ref()
                        .map(|m| m.id.clone())
                        .unwrap_or_default(),
                    g.conversations.clone(),
                )
            };
            let tags: Vec<String> = convs.iter().map(|c| contact_tag(&c.id, &my_id)).collect();
            let rand_id = random_id().unwrap_or_else(|_| "00000000".into());
            let endpoint_name = build_endpoint_name(&EndpointName {
                alias: random_alias(rand_id.as_bytes()),
                id: rand_id[..8].to_string(),
                tags,
            });
            match platform::nearby_start(&endpoint_name) {
                Ok(()) => {
                    s.lock().await.radar_on = true;
                    on_ui(&w, |ui| {
                        ui.set_radar_on(true);
                        ui.set_nearby_error(SharedString::default());
                    });
                }
                Err(err) => {
                    on_ui(&w, move |ui| {
                        ui.set_radar_on(false);
                        ui.set_nearby_error(err.into());
                    });
                }
            }
        });
    });

    let rt_c = rt.clone();
    let st_c = state.clone();
    window.on_connect_nearby_peer(move |endpoint_id| {
        let eid = endpoint_id.to_string();
        let s = st_c.clone();
        rt_c.spawn(async move {
            let my_id = s
                .lock()
                .await
                .client
                .me
                .as_ref()
                .map(|m| m.id.clone())
                .unwrap_or_else(|| "00000000".into());
            let local_name = build_endpoint_name(&EndpointName {
                alias: random_alias(my_id.as_bytes()),
                id: my_id.chars().take(8).collect(),
                tags: Vec::new(),
            });
            platform::nearby_request(&eid, &local_name);
        });
    });

    window.on_accept_nearby_peer(move |endpoint_id| {
        platform::nearby_accept(endpoint_id.as_str());
    });

    window.on_reject_nearby_peer(move |endpoint_id| {
        platform::nearby_reject(endpoint_id.as_str());
    });

    let weak = window.as_weak();
    let rt_c = rt.clone();
    let st_c = state.clone();
    window.on_open_nearby_chat(move |peer| {
        let w = weak.clone();
        let s = st_c.clone();
        let uid = peer.user_id.to_string();
        let uname = peer.username.to_string();
        rt_c.spawn(async move {
            let conv = {
                let mut g = s.lock().await;
                g.active_nearby_user_id = Some(uid.clone());
                g.conversations.iter().find(|c| c.peer_id == uid).cloned()
            };
            if let Some(c) = conv {
                open_conversation(&w, &s, c).await;
                return;
            }
            let msgs = {
                s.lock()
                    .await
                    .nearby_messages_by_user
                    .get(&uid)
                    .cloned()
                    .unwrap_or_default()
            };
            on_ui(&w, move |ui| {
                ui.set_nearby_peer_username(uname.into());
                ui.set_nearby_connected(true);
                ui.set_nearby_messages(ModelRc::from(Rc::new(VecModel::from(msgs))));
                ui.set_screen("nearby_chat".into());
            });
        });
    });

    let weak = window.as_weak();
    let rt_c = rt.clone();
    let st_c = state.clone();
    window.on_send_nearby_message(move |raw_text| {
        let text = raw_text.trim().to_string();
        if text.is_empty() {
            return;
        }
        on_ui(&weak, |ui| {
            ui.set_nearby_draft(SharedString::default());
            ui.set_nearby_chat_error(SharedString::default());
        });
        let w = weak.clone();
        let s = st_c.clone();
        rt_c.spawn(async move {
            let now = now_iso_utc();
            let sent = {
                let mut g = s.lock().await;
                let Some(peer_uid) = g.active_nearby_user_id.clone() else {
                    return;
                };
                let Some(peer) = g
                    .nearby_peers
                    .iter()
                    .find(|p| p.user_id.as_str() == peer_uid)
                    .cloned()
                else {
                    on_ui(&w, |ui| {
                        ui.set_nearby_chat_error("Perangkat lawan tidak terhubung.".into())
                    });
                    return;
                };
                let Some(me) = g.client.me.clone() else {
                    return;
                };
                let conv_id = g
                    .conversations
                    .iter()
                    .find(|c| c.peer_id == peer_uid)
                    .map(|c| c.id.clone())
                    .unwrap_or_else(|| {
                        seru24_core::nearby::stranger_conversation_id(&me.id, &peer_uid)
                    });
                let Some(ring) = g.client.keyring.clone() else {
                    return;
                };
                let Some(my_ver) = me.key_version else { return };
                let peer_key = g
                    .nearby_keys
                    .get(&peer_uid)
                    .and_then(|rows| rows.first())
                    .cloned();
                let Some(pk) = peer_key else {
                    on_ui(&w, |ui| {
                        ui.set_nearby_chat_error("Menunggu pertukaran kunci E2EE…".into())
                    });
                    return;
                };
                let Ok(sealed) = g.e2ee.seal_text(
                    SealTarget {
                        conversation_id: &conv_id,
                        me: PartyKey {
                            user_id: &me.id,
                            key_version: my_ver,
                        },
                        peer_id: &peer_uid,
                        peer_key: &pk,
                    },
                    &ring,
                    &text,
                    None,
                    None,
                ) else {
                    return;
                };
                let msg = encode_nearby_message(
                    &NearbySendParams {
                        p_client_msg_id: sealed.p_client_msg_id.clone(),
                        p_ciphertext: sealed.p_ciphertext,
                        p_nonce: sealed.p_nonce,
                        p_sender_key_version: sealed.p_sender_key_version,
                        p_recipient_key_version: sealed.p_recipient_key_version,
                        p_reply_to: None,
                    },
                    &now,
                );
                platform::nearby_send(peer.endpoint_id.as_str(), &msg);
                let item = NearbyMsgItem {
                    id: sealed.p_client_msg_id.into(),
                    mine: true,
                    text: text.into(),
                    status: format!(
                        "{} · terkirim langsung",
                        seru24_core::chat::format_clock(Some(&now))
                    )
                    .into(),
                };
                let list = g.nearby_messages_by_user.entry(peer_uid).or_default();
                list.push(item);
                Some(list.clone())
            };
            if let Some(msgs) = sent {
                on_ui(&w, move |ui| {
                    ui.set_nearby_messages(ModelRc::from(Rc::new(VecModel::from(msgs))));
                });
            }
        });
    });

    // Voice call controls (Fase 5 hook into CallStateMachine + JNI)
    let weak = window.as_weak();
    let rt_c = rt.clone();
    let st_c = state.clone();
    window.on_call_start(move || {
        let w = weak.clone();
        let s = st_c.clone();
        rt_c.spawn(async move {
            let call_id = random_id().unwrap_or_else(|_| "call-1".into());
            let actions = {
                let mut g = s.lock().await;
                g.call_sm.start_outgoing(call_id, true)
            };
            platform::call_audio_begin();
            run_call_actions(&w, &s, actions).await;
        });
    });

    let weak = window.as_weak();
    let rt_c = rt.clone();
    let st_c = state.clone();
    window.on_call_accept(move || {
        let w = weak.clone();
        let s = st_c.clone();
        rt_c.spawn(async move {
            let actions = { s.lock().await.call_sm.accept_incoming(true) };
            platform::call_audio_begin();
            run_call_actions(&w, &s, actions).await;
        });
    });

    let weak = window.as_weak();
    let rt_c = rt.clone();
    let st_c = state.clone();
    window.on_call_reject(move || {
        let w = weak.clone();
        let s = st_c.clone();
        rt_c.spawn(async move {
            let actions = { s.lock().await.call_sm.reject_incoming() };
            run_call_actions(&w, &s, actions).await;
        });
    });

    let weak = window.as_weak();
    let rt_c = rt.clone();
    let st_c = state.clone();
    window.on_call_hangup(move || {
        let w = weak.clone();
        let s = st_c.clone();
        rt_c.spawn(async move {
            let actions = { s.lock().await.call_sm.hangup() };
            run_call_actions(&w, &s, actions).await;
        });
    });

    let weak = window.as_weak();
    let rt_c = rt.clone();
    let st_c = state.clone();
    window.on_call_toggle_mute(move || {
        let w = weak.clone();
        let s = st_c.clone();
        rt_c.spawn(async move {
            let muted = {
                let mut g = s.lock().await;
                g.call_muted = !g.call_muted;
                g.call_muted
            };
            platform::webrtc_set_muted(muted);
            on_ui(&w, move |ui| ui.set_call_muted(muted));
        });
    });

    let weak = window.as_weak();
    let rt_c = rt.clone();
    let st_c = state.clone();
    window.on_call_toggle_speaker(move || {
        let w = weak.clone();
        let s = st_c.clone();
        rt_c.spawn(async move {
            let spk = {
                let mut g = s.lock().await;
                g.call_speaker = !g.call_speaker;
                g.call_speaker
            };
            platform::call_audio_set_speaker(spk);
            on_ui(&w, move |ui| ui.set_call_speaker(spk));
        });
    });

    let weak = window.as_weak();
    let rt_c = rt.clone();
    let st_c = state.clone();
    window.on_install_update(move || {
        let w = weak.clone();
        let s = st_c.clone();
        on_ui(&w, |ui| ui.set_update_status("Mengunduh pembaruan…".into()));
        rt_c.spawn(async move {
            let rel = { s.lock().await.latest_release.clone() };
            if let Some(r) = rel {
                match platform::download_and_install_update(&r.download_url, &r.sha256) {
                    Ok(()) => on_ui(&w, |ui| {
                        ui.set_update_status("Sudah diunduh. Ikuti layar instal Android.".into());
                    }),
                    Err(err) => on_ui(&w, move |ui| ui.set_update_status(err.into())),
                }
            }
        });
    });

    let rt_c = rt.clone();
    let st_c = state.clone();
    window.on_open_update_link(move || {
        let s = st_c.clone();
        rt_c.spawn(async move {
            if let Some(r) = s.lock().await.latest_release.clone() {
                platform::open_url(&r.download_url);
            }
        });
    });
}

async fn apply_backup_import(
    weak: &Weak<MainWindow>,
    state: &Arc<Mutex<AppState>>,
    vault: &seru24_core::storage::LocalVault,
    ring: &seru24_core::crypto::SecretKeyring,
    my_id: &str,
    raw: &str,
) {
    match open_backup(ring, my_id, raw) {
        Ok(data) => {
            let existing = vault.load_conversations(my_id).unwrap_or_default();
            let merged = merge_conversations(&existing, &data.conversations);
            let _ = vault.save_conversations(my_id, &merged);
            for (cid, msgs) in group_messages_by_conversation(&data.messages) {
                let _ = vault.save_messages(my_id, &cid, &msgs);
            }
            state.lock().await.conversations = merged;
            refresh_chat_list_ui(weak, state).await;
            let msg = format!(
                "{} percakapan dan {} pesan digabungkan.",
                data.conversations.len(),
                data.messages.len()
            );
            on_ui(weak, move |ui| ui.set_account_notice(msg.into()));
        }
        Err(e) => {
            let msg = e.to_string();
            on_ui(weak, move |ui| ui.set_account_error(msg.into()));
        }
    }
}

fn phase_str(phase: CallPhase) -> &'static str {
    match phase {
        CallPhase::Idle => "idle",
        CallPhase::Calling => "calling",
        CallPhase::Incoming => "incoming",
        CallPhase::Connecting => "connecting",
        CallPhase::Connected => "connected",
    }
}

fn call_end_note(reason: CallEndReason) -> &'static str {
    match reason {
        CallEndReason::Hangup => "Panggilan diakhiri",
        CallEndReason::Rejected => "Panggilan ditolak",
        CallEndReason::Busy => "Pengguna sedang sibuk",
        CallEndReason::Timeout => "Tidak terjawab",
        CallEndReason::Failed => "Koneksi telepon gagal",
        CallEndReason::MicDenied => "Izin mikrofon ditolak",
    }
}

pub(crate) fn run_call_actions<'a>(
    weak: &'a Weak<MainWindow>,
    state: &'a Arc<Mutex<AppState>>,
    actions: Vec<CallAction>,
) -> std::pin::Pin<Box<dyn std::future::Future<Output = ()> + Send + 'a>> {
    Box::pin(async move {
        let (conv_id, phase, bitrate) = {
            let g = state.lock().await;
            (
                g.active_conv
                    .as_ref()
                    .map(|c| c.id.clone())
                    .unwrap_or_default(),
                g.call_sm.phase(),
                g.call_quality.option().bitrate,
            )
        };
        let pstr = phase_str(phase);
        on_ui(weak, move |ui| ui.set_call_phase(pstr.into()));

        for action in actions {
            match action {
                CallAction::EmitSignal(sig) => {
                    if !conv_id.is_empty() {
                        if let Some(ref rt) = state.lock().await.realtime {
                            rt.send_call_signal(&conv_id, sig);
                        }
                    }
                }
                CallAction::CreateOffer { .. } => {
                    if !platform::webrtc_create_offer(bitrate) {
                        let end = { state.lock().await.call_sm.hangup() };
                        platform::call_audio_end();
                        on_ui(weak, |ui| {
                            ui.set_call_phase("idle".into());
                            ui.set_call_note(
                                "WebRTC Android aktif setelah build Gradle (org.webrtc).".into(),
                            );
                        });
                        let _ = end;
                    }
                }
                CallAction::SetRemoteOfferAndCreateAnswer { sdp } => {
                    platform::webrtc_handle_offer(&sdp, bitrate);
                }
                CallAction::SetRemoteAnswer { sdp } => {
                    platform::webrtc_handle_answer(&sdp);
                }
                CallAction::AddIceCandidate(cand) => {
                    platform::webrtc_add_ice(&cand);
                }
                CallAction::Teardown(reason) => {
                    platform::webrtc_close();
                    platform::call_audio_end();
                    let note = call_end_note(reason);
                    on_ui(weak, move |ui| {
                        ui.set_call_phase("idle".into());
                        ui.set_call_note(note.into());
                    });
                }
                CallAction::PeerRecording(on) => {
                    on_ui(weak, move |ui| ui.set_call_peer_recording(on));
                }
                CallAction::StartRingTimeout {
                    notify_peer_on_timeout,
                } => {
                    let w = weak.clone();
                    let s = state.clone();
                    tokio::spawn(async move {
                        tokio::time::sleep(std::time::Duration::from_millis(CALL_RING_TIMEOUT_MS))
                            .await;
                        let next_actions = {
                            s.lock()
                                .await
                                .call_sm
                                .on_ring_timeout(notify_peer_on_timeout)
                        };
                        if !next_actions.is_empty() {
                            run_call_actions(&w, &s, next_actions).await;
                        }
                    });
                }
                CallAction::ClearRingTimeout => {}
            }
        }
    })
}

pub(crate) async fn handle_incoming_call_signal(
    weak: &Weak<MainWindow>,
    state: &Arc<Mutex<AppState>>,
    conversation_id: &str,
    signal: CallSignal,
) {
    let is_active = state
        .lock()
        .await
        .active_conv
        .as_ref()
        .map(|c| c.id == conversation_id)
        .unwrap_or(false);
    if !is_active {
        return;
    }
    let actions = { state.lock().await.call_sm.handle_signal(signal) };
    run_call_actions(weak, state, actions).await;
}

pub(crate) async fn handle_platform_event(
    weak: &Weak<MainWindow>,
    state: &Arc<Mutex<AppState>>,
    _rt: &Arc<Runtime>,
    event: PlatformEvent,
) {
    match event {
        PlatformEvent::FcmToken(tok) => {
            let (notify, rpc) = {
                let g = state.lock().await;
                (g.notify_enabled, g.client.rpc.clone())
            };
            if notify {
                let _ = rpc.register_push_token("android", &tok).await;
            }
        }
        PlatformEvent::FilesPicked(files) => {
            let is_backup_pick = {
                let mut g = state.lock().await;
                std::mem::take(&mut g.pending_backup_import)
            };
            if is_backup_pick {
                if let Some(f) = files.first() {
                    if let Some(raw) = platform::read_text_uri(&f.uri) {
                        let (my_id, ring, vault) = {
                            let g = state.lock().await;
                            (
                                g.client
                                    .me
                                    .as_ref()
                                    .map(|m| m.id.clone())
                                    .unwrap_or_default(),
                                g.client.keyring.clone(),
                                g.client.vault.clone(),
                            )
                        };
                        if let Some(ring) = ring {
                            apply_backup_import(weak, state, &vault, &ring, &my_id, &raw).await;
                        }
                    }
                }
                return;
            }
            for f in files {
                let (conv, my_id, my_ver, ring, rpc, secure, token) = {
                    let g = state.lock().await;
                    let Some(c) = g.active_conv.clone() else {
                        return;
                    };
                    let Some(me) = g.client.me.clone() else {
                        return;
                    };
                    let Some(r) = g.client.keyring.clone() else {
                        return;
                    };
                    let Some(v) = me.key_version else {
                        return;
                    };
                    let tok = g
                        .client
                        .session
                        .get_access_token()
                        .await
                        .ok()
                        .flatten()
                        .map(|t| t.to_string())
                        .unwrap_or_default();
                    (
                        c,
                        me.id,
                        v,
                        r,
                        g.client.rpc.clone(),
                        g.client.secure.clone(),
                        tok,
                    )
                };
                if let Ok(start) = secure
                    .secure_post::<_, serde_json::Value>(
                        "/api/files/start",
                        &json!({
                            "access_token": token,
                            "conversation_id": conv.id,
                            "size": f.size + FILE_TAG_BYTES
                        }),
                    )
                    .await
                {
                    let Some(att_id) = start.get("id").and_then(|v| v.as_str()).map(str::to_string)
                    else {
                        continue;
                    };
                    if let Ok((key, iv)) = platform::encrypt_and_upload_file(
                        &f.uri,
                        &att_id,
                        secure.base_url(),
                        &token,
                    ) {
                        let body = seru24_core::file::FileMessageBody {
                            id: att_id,
                            name: seru24_core::file::safe_file_name(&f.name),
                            mime: f.mime,
                            size: f.size,
                            key,
                            iv,
                        };
                        let sealed = {
                            let mut g = state.lock().await;
                            let Some(pk) = g.e2ee.latest_active_key(&conv.peer_id).cloned() else {
                                continue;
                            };
                            g.e2ee
                                .seal_file(
                                    SealTarget {
                                        conversation_id: &conv.id,
                                        me: PartyKey {
                                            user_id: &my_id,
                                            key_version: my_ver,
                                        },
                                        peer_id: &conv.peer_id,
                                        peer_key: &pk,
                                    },
                                    &ring,
                                    &body,
                                    None,
                                )
                                .ok()
                        };
                        if let Some(params) = sealed {
                            if let Ok(res) = seru24_core::outbox::send_with_offline_time(
                                &rpc,
                                &params,
                                &now_iso_utc(),
                            )
                            .await
                            {
                                if res.ok {
                                    apply_incoming_message(
                                        weak,
                                        state,
                                        ChatMessage {
                                            id: res
                                                .id
                                                .unwrap_or_else(|| params.p_client_msg_id.clone()),
                                            conversation_id: conv.id,
                                            sender_id: Some(my_id),
                                            seq: res.seq.unwrap_or(0),
                                            client_msg_id: params.p_client_msg_id,
                                            kind: params.p_kind,
                                            ciphertext: Some(params.p_ciphertext),
                                            nonce: Some(params.p_nonce),
                                            sender_key_version: params.p_sender_key_version,
                                            recipient_key_version: params.p_recipient_key_version,
                                            reply_to: params.p_reply_to,
                                            created_at: res.created_at.unwrap_or_else(now_iso_utc),
                                            offline_sent_at: None,
                                            edited_at: None,
                                            deleted_at: None,
                                            expires_at: None,
                                        },
                                    )
                                    .await;
                                }
                            }
                        }
                    }
                }
            }
        }
        PlatformEvent::NearbyEvent {
            kind,
            endpoint_id,
            value,
        } => {
            let mut g = state.lock().await;
            match kind.as_str() {
                "found" => {
                    if let Some(ep) = parse_endpoint_name(&value) {
                        g.nearby_endpoint_names.insert(endpoint_id.clone(), value);
                        if !g
                            .nearby_peers
                            .iter()
                            .any(|p| p.endpoint_id.as_str() == endpoint_id)
                        {
                            let initials = initials_of(&ep.alias);
                            let color = avatar_color(&ep.alias);
                            g.nearby_peers.push(NearbyPeerItem {
                                endpoint_id: endpoint_id.clone().into(),
                                alias: ep.alias.into(),
                                username: SharedString::default(),
                                initials: initials.into(),
                                avatar_color: color,
                                user_id: ep.id.clone().into(),
                                phase: "found".into(),
                                trusted: false,
                                code: SharedString::default(),
                                unread: 0,
                            });
                        }
                        let my_short = g
                            .client
                            .me
                            .as_ref()
                            .map(|m| m.id.chars().take(8).collect::<String>())
                            .unwrap_or_default();
                        if should_initiate(&my_short, &ep.id) {
                            let my_name = build_endpoint_name(&EndpointName {
                                alias: random_alias(my_short.as_bytes()),
                                id: my_short,
                                tags: Vec::new(),
                            });
                            platform::nearby_request(&endpoint_id, &my_name);
                        }
                    }
                }
                "connected" => {
                    if let (Some(me), Some(ring)) = (&g.client.me, &g.client.keyring) {
                        if let Some(ver) = me.key_version {
                            if let Some(pk) =
                                seru24_core::e2ee::E2eeEngine::my_public_key_b64(ring, ver)
                            {
                                let hello = encode_nearby_hello(&NearbyHello {
                                    u: me.id.clone(),
                                    n: me.username.clone(),
                                    k: ver,
                                    pk,
                                });
                                platform::nearby_send(&endpoint_id, &hello);
                            }
                        }
                    }
                }
                "payload" => {
                    if let Some(wire) = parse_nearby_wire(&value) {
                        match wire {
                            NearbyWire::Hello { h } => {
                                let pk_row = seru24_core::e2ee::PublicKeyRow {
                                    key_version: h.k,
                                    public_key: h.pk.clone(),
                                    revoked: false,
                                };
                                g.nearby_keys.insert(h.u.clone(), vec![pk_row.clone()]);
                                g.e2ee.cache_public_keys(&h.u, vec![pk_row]);
                                let code = g
                                    .client
                                    .keyring
                                    .as_ref()
                                    .and_then(|ring| {
                                        g.client.me.as_ref().and_then(|me| {
                                            me.key_version.and_then(|ver| {
                                                seru24_core::e2ee::E2eeEngine::my_public_key_b64(
                                                    ring, ver,
                                                )
                                            })
                                        })
                                    })
                                    .and_then(|my_pk| {
                                        let a = seru24_core::crypto::from_base64(&my_pk).ok()?;
                                        let b = seru24_core::crypto::from_base64(&h.pk).ok()?;
                                        let ka = seru24_core::crypto::as_key_array(&a).ok()?;
                                        let kb = seru24_core::crypto::as_key_array(&b).ok()?;
                                        Some(seru24_core::crypto::safety_code(&ka, &kb))
                                    })
                                    .unwrap_or_default();
                                let trusted = g.conversations.iter().any(|c| c.peer_id == h.u);
                                if let Some(p) = g
                                    .nearby_peers
                                    .iter_mut()
                                    .find(|p| p.endpoint_id.as_str() == endpoint_id)
                                {
                                    p.initials = initials_of(&h.n).into();
                                    p.avatar_color = avatar_color(&h.n);
                                    p.username = h.n.into();
                                    p.user_id = h.u.into();
                                    p.phase = "ready".into();
                                    p.trusted = trusted;
                                    p.code = code.into();
                                }
                            }
                            NearbyWire::Msg { m } => {
                                platform::nearby_send(
                                    &endpoint_id,
                                    &encode_nearby_ack(&m.client_msg_id),
                                );
                                let peer_uid = g
                                    .nearby_peers
                                    .iter()
                                    .find(|p| p.endpoint_id.as_str() == endpoint_id)
                                    .map(|p| p.user_id.to_string())
                                    .unwrap_or_default();
                                if !peer_uid.is_empty() {
                                    let my_id = g
                                        .client
                                        .me
                                        .as_ref()
                                        .map(|me| me.id.clone())
                                        .unwrap_or_default();
                                    let conv_id = g
                                        .conversations
                                        .iter()
                                        .find(|c| c.peer_id == peer_uid)
                                        .map(|c| c.id.clone())
                                        .unwrap_or_else(|| {
                                            seru24_core::nearby::stranger_conversation_id(
                                                &my_id, &peer_uid,
                                            )
                                        });
                                    let fake_msg = ChatMessage {
                                        id: m.client_msg_id.clone(),
                                        conversation_id: conv_id,
                                        sender_id: Some(peer_uid.clone()),
                                        seq: 0,
                                        client_msg_id: m.client_msg_id.clone(),
                                        kind: seru24_core::crypto::MessageKind::Text,
                                        ciphertext: Some(m.ciphertext),
                                        nonce: Some(m.nonce),
                                        sender_key_version: m.sender_key_version,
                                        recipient_key_version: m.recipient_key_version,
                                        reply_to: m.reply_to,
                                        created_at: m.created_at.clone(),
                                        offline_sent_at: None,
                                        edited_at: None,
                                        deleted_at: None,
                                        expires_at: None,
                                    };
                                    let ring = g.client.keyring.clone();
                                    let plain = ring
                                        .as_ref()
                                        .and_then(|r| {
                                            g.e2ee
                                                .decrypt_text(&fake_msg, &my_id, &peer_uid, r, None)
                                        })
                                        .unwrap_or_else(|| "Pesan tidak dapat dibuka".into());
                                    let item = NearbyMsgItem {
                                        id: m.client_msg_id.into(),
                                        mine: false,
                                        text: plain.into(),
                                        status: seru24_core::chat::format_clock(Some(
                                            &m.created_at,
                                        ))
                                        .into(),
                                    };
                                    let is_active_nearby = g.active_nearby_user_id.as_deref()
                                        == Some(peer_uid.as_str());
                                    let msgs_opt = {
                                        let list = g
                                            .nearby_messages_by_user
                                            .entry(peer_uid.clone())
                                            .or_default();
                                        list.push(item);
                                        if is_active_nearby {
                                            Some(list.clone())
                                        } else {
                                            None
                                        }
                                    };
                                    if let Some(msgs) = msgs_opt {
                                        on_ui(weak, move |ui| {
                                            ui.set_nearby_messages(ModelRc::from(Rc::new(
                                                VecModel::from(msgs),
                                            )));
                                        });
                                    } else if let Some(p) = g
                                        .nearby_peers
                                        .iter_mut()
                                        .find(|p| p.user_id.as_str() == peer_uid)
                                    {
                                        p.unread += 1;
                                    }
                                }
                            }
                            NearbyWire::Ack { .. } => {}
                        }
                    }
                }
                "disconnected" => {
                    g.nearby_peers
                        .retain(|p| p.endpoint_id.as_str() != endpoint_id);
                }
                _ => {}
            }
            let peers = g.nearby_peers.clone();
            drop(g);
            on_ui(weak, move |ui| {
                ui.set_nearby_peers(ModelRc::from(Rc::new(VecModel::from(peers))));
            });
        }
        PlatformEvent::WebRtcOffer { sdp } => {
            let mut sig = serde_json::from_str::<CallSignal>(
                &serde_json::to_string(&json!({
                    "type": "offer",
                    "callId": state.lock().await.call_sm.call_id(),
                    "from": state.lock().await.client.me.as_ref().map(|m| m.id.clone()).unwrap_or_default(),
                    "sdp": sdp
                }))
                .unwrap_or_default(),
            );
            if let Ok(ref mut s) = sig {
                let g = state.lock().await;
                if let (Some(ref conv), Some(ref rt)) = (&g.active_conv, &g.realtime) {
                    rt.send_call_signal(&conv.id, s.clone());
                }
            }
        }
        PlatformEvent::WebRtcAnswer { sdp } => {
            let g = state.lock().await;
            if let (Some(ref conv), Some(ref rt), Some(ref me)) =
                (&g.active_conv, &g.realtime, &g.client.me)
            {
                rt.send_call_signal(
                    &conv.id,
                    CallSignal {
                        signal_type: seru24_core::call_core::CallSignalType::Answer,
                        call_id: g.call_sm.call_id().to_string(),
                        from: me.id.clone(),
                        sdp: Some(sdp),
                        candidate: None,
                        on: None,
                    },
                );
            }
        }
        PlatformEvent::WebRtcIce(cand) => {
            let g = state.lock().await;
            if let (Some(ref conv), Some(ref rt), Some(ref me)) =
                (&g.active_conv, &g.realtime, &g.client.me)
            {
                rt.send_call_signal(
                    &conv.id,
                    CallSignal {
                        signal_type: seru24_core::call_core::CallSignalType::Ice,
                        call_id: g.call_sm.call_id().to_string(),
                        from: me.id.clone(),
                        sdp: None,
                        candidate: Some(cand),
                        on: None,
                    },
                );
            }
        }
        PlatformEvent::WebRtcConnectionState(st) => {
            if st == "connected" {
                let actions = { state.lock().await.call_sm.on_connected() };
                run_call_actions(weak, state, actions).await;
            } else if st == "failed" {
                let actions = { state.lock().await.call_sm.hangup() };
                run_call_actions(weak, state, actions).await;
            }
        }
        PlatformEvent::FileProgress { .. } => {}
    }
    let _ = ListConversationsOptions::default();
}
