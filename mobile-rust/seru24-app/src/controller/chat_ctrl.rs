//! Logika UI & RPC untuk `ChatScreen` (`mobile/src/screens/ChatScreen.tsx`).

use std::collections::HashSet;
use std::rc::Rc;
use std::sync::Arc;

use chrono::Local;
use seru24_core::call_quality::call_quality_key;
use seru24_core::chat::{
    bubble_status, format_clock, format_day_label, merge_cached_messages, message_time,
    now_iso_utc, oldest_persisted_seq, peer_label, reply_snippet, send_error_message,
    slice_messages_page, Conversation, ConversationStatus, CHAT_PAGE_SIZE,
};
use seru24_core::crypto::PartyKey;
use seru24_core::e2ee::{ChatMessage, PeerKeyStatus, SealTarget};
use seru24_core::file::{
    format_clock_seconds, format_file_size, is_voice_file, parse_file_body,
    voice_seconds_from_name, FileMessageBody,
};
use seru24_core::outbox::{queue_message, queued_for, send_with_offline_time, QueuedMessage};
use seru24_core::pin::{add_pin, parse_pins, pins_storage_key, prune_pins, remove_pin};
use seru24_core::schedule::{
    parse_clock_input, schedule_error_message, schedule_presets, scheduled_as_message,
    validate_schedule_time, ScheduleProblem,
};
use seru24_core::search::{search_messages, SearchableMessage};
use slint::{ComponentHandle, ModelRc, SharedString, VecModel, Weak};
use tokio::runtime::Runtime;
use tokio::sync::Mutex;

use crate::controller::{avatar_color, initials_of, on_ui, AppState, UiBubble};
use crate::platform;
use crate::{BubbleItem, MainWindow, PinItem, ScheduledItem, SearchHitItem};

fn schedule_scroll_to_bottom(weak: &Weak<MainWindow>) {
    let w = weak.clone();
    tokio::spawn(async move {
        tokio::time::sleep(std::time::Duration::from_millis(35)).await;
        on_ui(&w, |ui| {
            ui.invoke_scroll_chat_to_bottom();
        });
    });
}

pub(crate) async fn open_conversation(
    weak: &Weak<MainWindow>,
    state: &Arc<Mutex<AppState>>,
    conv: Conversation,
) {
    let name = peer_label(&conv.peer_display_name, &conv.peer_username);
    let init = initials_of(&name);
    let peer_color = avatar_color(&conv.peer_username);
    let peer_username = conv.peer_username.clone();
    let incoming = conv.status == ConversationStatus::Pending
        && conv.requested_by.as_deref()
            != state.lock().await.client.me.as_ref().map(|m| m.id.as_str());
    let blocked = conv.peer_blocked;
    let conv_id = conv.id.clone();
    let peer_id = conv.peer_id.clone();

    let (vault, rpc, my_id, keyring, notify_on, q_label) = {
        let mut g = state.lock().await;
        if let Some(ref prev) = g.active_conv {
            if let Some(ref rt) = g.realtime {
                rt.close_conversation(&prev.id);
            }
        }
        g.active_conv = Some(conv.clone());
        g.all_messages.clear();
        g.bubbles.clear();
        g.peer_read_seq = 0;
        g.reply_to_id = None;
        g.server_exhausted = false;
        g.has_older = false;
        let q_raw = g
            .client
            .vault
            .get_secret(&call_quality_key(&conv_id))
            .ok()
            .flatten();
        let quality =
            seru24_core::call_quality::CallQuality::parse(q_raw.as_deref().map(|s| s.as_str()));
        g.call_quality = quality;
        if let Some(ref rt) = g.realtime {
            rt.open_conversation(&conv_id);
        }
        (
            g.client.vault.clone(),
            g.client.rpc.clone(),
            g.client
                .me
                .as_ref()
                .map(|m| m.id.clone())
                .unwrap_or_default(),
            g.client.keyring.clone(),
            g.notify_enabled,
            quality.option().label,
        )
    };

    platform::set_notification_presence(notify_on, true, Some(&conv_id));

    on_ui(weak, move |ui| {
        ui.set_screen("chat".into());
        ui.set_active_peer_name(name.into());
        ui.set_active_peer_username(peer_username.into());
        ui.set_active_peer_initials(init.into());
        ui.set_active_peer_avatar_color(peer_color);
        ui.set_peer_online(false);
        ui.set_peer_typing(false);
        ui.set_peer_near(false);
        ui.set_active_incoming_request(incoming);
        ui.set_active_peer_blocked(blocked);
        ui.set_key_changed(false);
        ui.set_chat_error(SharedString::default());
        ui.set_reply_target_snippet(SharedString::default());
        ui.set_call_quality_label(q_label.into());
        ui.set_draft(SharedString::default());
    });

    // Load cached local state first
    if let Ok(cached_state) = vault.load_conversation_state(&my_id, &conv_id) {
        let mut g = state.lock().await;
        g.all_messages = cached_state.messages;
        let raw_pins = vault
            .get_secret(&pins_storage_key(&my_id, &conv_id))
            .ok()
            .flatten()
            .map(|s| s.to_string());
        g.pins = parse_pins(raw_pins.as_deref());
    }

    // Ensure peer public keys loaded (cache fallback if offline)
    let pks = match rpc.get_public_keys(&peer_id).await {
        Ok(rows) => {
            let _ = vault.save_pubkeys(&peer_id, &rows);
            rows
        }
        Err(_) => vault
            .load_pubkeys(&peer_id)
            .ok()
            .flatten()
            .unwrap_or_default(),
    };
    {
        let mut g = state.lock().await;
        g.e2ee.cache_public_keys(&peer_id, pks.clone());
        if let (Some(ring), Some(me)) = (&keyring, &g.client.me) {
            if let (Some(ver), Some(latest)) =
                (me.key_version, pks.iter().rev().find(|r| !r.revoked))
            {
                if let Some(my_sec) = ring.get(&ver.to_string()) {
                    let known = vault.load_tofu(&my_id, &peer_id).ok().flatten();
                    if known.is_none() {
                        let _ = vault.save_tofu(&my_id, &peer_id, &latest.public_key);
                    }
                    let status = seru24_core::e2ee::E2eeEngine::verify_peer_tofu(
                        my_sec,
                        &latest.public_key,
                        known.as_deref(),
                    );
                    let (changed, code) = match status {
                        PeerKeyStatus::Ok { code } => (false, code),
                        PeerKeyStatus::Changed { code } => (true, code),
                        PeerKeyStatus::Missing => (false, String::new()),
                    };
                    on_ui(weak, move |ui| {
                        ui.set_key_changed(changed);
                        ui.set_safety_code(code.into());
                    });
                }
            }
        }
    }

    if let Ok(seq) = rpc.peer_read_seq(&conv_id).await {
        state.lock().await.peer_read_seq = seq;
    }

    sync_bubbles_to_ui(weak, state).await;

    if let Ok(rows) = rpc.get_messages(&conv_id, None, CHAT_PAGE_SIZE).await {
        let exhausted = rows.len() < CHAT_PAGE_SIZE;
        let _ = vault.save_messages(&my_id, &conv_id, &rows);
        let latest_seq = {
            let mut g = state.lock().await;
            let local_st = vault.load_conversation_state(&my_id, &conv_id).ok();
            let deleted_ids = local_st.as_ref().map(|s| &s.deleted_ids);
            let cleared = local_st.as_ref().map(|s| s.cleared_up_to_seq).unwrap_or(0);
            g.all_messages = merge_cached_messages(&g.all_messages, &rows, deleted_ids, cleared);
            g.server_exhausted = exhausted;
            g.all_messages.last().map(|m| m.seq).unwrap_or(0)
        };
        if latest_seq > 0 {
            let _ = rpc.mark_read(&conv_id, latest_seq).await;
        }
        sync_bubbles_to_ui(weak, state).await;
    }

    load_scheduled_ui(weak, state).await;
}

pub(crate) async fn sync_bubbles_to_ui(weak: &Weak<MainWindow>, state: &Arc<Mutex<AppState>>) {
    let (ui_items, pin_items, has_older) = {
        let mut g = state.lock().await;
        let Some(conv) = g.active_conv.clone() else {
            return;
        };
        let my_id = g
            .client
            .me
            .as_ref()
            .map(|m| m.id.clone())
            .unwrap_or_default();
        let keyring = g.client.keyring.clone();
        let all_clone = g.all_messages.clone();
        let peer_id = conv.peer_id.clone();

        let (slice_rows, local_older) = slice_messages_page(&all_clone, None, CHAT_PAGE_SIZE);
        let has_older = local_older || !g.server_exhausted;
        g.has_older = has_older;

        let mut merged_msgs = slice_rows;
        if let Ok(queued) = queued_for(&g.client.vault, &my_id, &conv.id) {
            for q in queued {
                if !merged_msgs
                    .iter()
                    .any(|m| m.client_msg_id == q.params.p_client_msg_id)
                {
                    merged_msgs.push(ChatMessage {
                        id: q.params.p_client_msg_id.clone(),
                        conversation_id: q.conversation_id.clone(),
                        sender_id: Some(my_id.clone()),
                        seq: 0,
                        client_msg_id: q.params.p_client_msg_id,
                        kind: q.params.p_kind,
                        ciphertext: Some(q.params.p_ciphertext),
                        nonce: Some(q.params.p_nonce),
                        sender_key_version: q.params.p_sender_key_version,
                        recipient_key_version: q.params.p_recipient_key_version,
                        reply_to: q.params.p_reply_to,
                        created_at: q.queued_at.clone(),
                        offline_sent_at: Some(q.queued_at),
                        edited_at: None,
                        deleted_at: None,
                        expires_at: None,
                    });
                }
            }
        }

        let mut decrypted_by_id: std::collections::HashMap<String, (bool, Option<String>, bool)> =
            std::collections::HashMap::new();
        let mut bubbles = Vec::with_capacity(merged_msgs.len());
        let now_local = Local::now();

        for msg in &merged_msgs {
            let mine = msg.sender_id.as_deref() == Some(my_id.as_str());
            let deleted = msg.deleted_at.is_some();
            let mut text = if deleted {
                Some("Pesan dihapus".to_string())
            } else {
                None
            };
            let mut file_body: Option<FileMessageBody> = None;

            if !deleted {
                if let Some(ref ring) = keyring {
                    if let Some(raw) = g.e2ee.open_body(msg, &my_id, &peer_id, ring, None) {
                        if let Some(serde_json::Value::String(t)) = raw.t {
                            text = Some(t);
                        } else if let Some(ref fval) = raw.f {
                            file_body = parse_file_body(fval);
                        }
                    } else {
                        text = Some("🔒 Pesan tidak dapat dibuka".to_string());
                    }
                }
            }
            decrypted_by_id.insert(msg.id.clone(), (mine, text.clone(), deleted));

            let created = message_time(&msg.created_at, msg.offline_sent_at.as_deref());
            let mut status =
                bubble_status(msg.seq == 0, "", mine, msg.seq, created, g.peer_read_seq);
            if msg.seq > 0 {
                status.text = format_clock(Some(created));
            }
            let is_file = file_body.is_some();
            let (is_voice, fname, fext, fsize) = match &file_body {
                Some(f) => {
                    let ext = f
                        .name
                        .rsplit('.')
                        .next()
                        .unwrap_or("FILE")
                        .chars()
                        .take(4)
                        .collect::<String>()
                        .to_uppercase();
                    (
                        is_voice_file(&f.mime),
                        f.name.clone(),
                        ext,
                        if is_voice_file(&f.mime) {
                            voice_seconds_from_name(&f.name)
                                .map(format_clock_seconds)
                                .unwrap_or_else(|| format_file_size(f.size))
                        } else {
                            format_file_size(f.size)
                        },
                    )
                }
                None => (false, String::new(), String::new(), String::new()),
            };

            bubbles.push(UiBubble {
                item: BubbleItem {
                    key: msg.client_msg_id.clone().into(),
                    server_id: if msg.seq > 0 {
                        msg.id.clone()
                    } else {
                        String::new()
                    }
                    .into(),
                    seq: msg.seq as i32,
                    mine,
                    text: text.unwrap_or_default().into(),
                    quote_who: SharedString::default(),
                    reply_snippet: SharedString::default(),
                    time: status.text.into(),
                    ticks: status.ticks.into(),
                    read: status.read,
                    revised: msg.offline_sent_at.is_some(),
                    deleted,
                    pending: msg.seq == 0,
                    failed: SharedString::default(),
                    is_file,
                    is_voice,
                    file_name: fname.into(),
                    file_ext: fext.into(),
                    file_size: fsize.into(),
                    progress: SharedString::default(),
                    saved_path: SharedString::default(),
                    day_label: SharedString::default(),
                },
                raw_msg: Some(msg.clone()),
                file: file_body,
            });
        }

        bubbles.sort_by(seru24_core::chat::compare_bubbles);

        let peer_disp = peer_label(&conv.peer_display_name, &conv.peer_username);
        let mut prev_day = String::new();
        for b in &mut bubbles {
            if let Some(ref raw) = b.raw_msg {
                if let Some(ref rep_id) = raw.reply_to {
                    if let Some((rep_mine, rep_txt, rep_del)) = decrypted_by_id.get(rep_id) {
                        b.item.quote_who = if *rep_mine {
                            "Anda".into()
                        } else {
                            peer_disp.clone().into()
                        };
                        b.item.reply_snippet = reply_snippet(rep_txt.as_deref(), *rep_del).into();
                    } else {
                        b.item.reply_snippet = "Pesan sebelumnya".into();
                    }
                }
                let t = message_time(&raw.created_at, raw.offline_sent_at.as_deref());
                let lbl = format_day_label(t, now_local);
                if lbl != prev_day && !lbl.is_empty() {
                    b.item.day_label = lbl.clone().into();
                    prev_day = lbl;
                }
            }
        }

        let live_keys: HashSet<String> = bubbles
            .iter()
            .filter(|b| !b.item.deleted)
            .map(|b| b.item.key.to_string())
            .collect();
        g.pins = prune_pins(&g.pins, &live_keys);
        let pin_items: Vec<PinItem> = g
            .pins
            .iter()
            .rev()
            .filter_map(|k| {
                bubbles
                    .iter()
                    .find(|b| b.item.key.as_str() == k.as_str())
                    .map(|b| PinItem {
                        key: k.clone().into(),
                        time_label: b.item.time.clone(),
                        snippet: b.item.text.clone(),
                    })
            })
            .collect();

        g.bubbles = bubbles.clone();
        let ui_items: Vec<BubbleItem> = bubbles.into_iter().map(|b| b.item).collect();
        (ui_items, pin_items, has_older)
    };

    on_ui(weak, move |ui| {
        ui.set_messages(ModelRc::from(Rc::new(VecModel::from(ui_items))));
        ui.set_pins(ModelRc::from(Rc::new(VecModel::from(pin_items))));
        ui.set_has_older(has_older);
    });
    schedule_scroll_to_bottom(weak);
}

pub(crate) async fn apply_incoming_message(
    weak: &Weak<MainWindow>,
    state: &Arc<Mutex<AppState>>,
    msg: ChatMessage,
) {
    let (conv_id, my_id, rpc) = {
        let mut g = state.lock().await;
        let my_id = g
            .client
            .me
            .as_ref()
            .map(|m| m.id.clone())
            .unwrap_or_default();
        let cid = msg.conversation_id.clone();
        let _ = g
            .client
            .vault
            .save_messages(&my_id, &cid, std::slice::from_ref(&msg));
        g.all_messages =
            merge_cached_messages(&g.all_messages, std::slice::from_ref(&msg), None, 0);
        (cid, my_id, g.client.rpc.clone())
    };
    if msg.sender_id.as_deref() != Some(my_id.as_str()) && msg.seq > 0 {
        let _ = rpc.mark_read(&conv_id, msg.seq).await;
    }
    sync_bubbles_to_ui(weak, state).await;
}

async fn load_scheduled_ui(weak: &Weak<MainWindow>, state: &Arc<Mutex<AppState>>) {
    let (rpc, conv_id, my_id, peer_id, keyring) = {
        let g = state.lock().await;
        let Some(ref conv) = g.active_conv else {
            return;
        };
        (
            g.client.rpc.clone(),
            conv.id.clone(),
            g.client
                .me
                .as_ref()
                .map(|m| m.id.clone())
                .unwrap_or_default(),
            conv.peer_id.clone(),
            g.client.keyring.clone(),
        )
    };
    if let Ok(rows) = rpc.list_scheduled(&conv_id).await {
        let mut list = Vec::with_capacity(rows.len());
        let mut ui_rows = Vec::with_capacity(rows.len());
        let mut g = state.lock().await;
        for row in rows {
            let txt = keyring.as_ref().and_then(|ring| {
                let fake = scheduled_as_message(&row, &conv_id, &my_id);
                g.e2ee.decrypt_text(&fake, &my_id, &peer_id, ring, None)
            });
            let failed = row.status == "failed";
            let when = if failed {
                "Gagal".to_string()
            } else {
                format_clock(Some(&row.send_at))
            };
            let body = if failed {
                schedule_error_message(row.error_code.as_deref().unwrap_or("")).to_string()
            } else {
                txt.clone().unwrap_or_else(|| "Pesan terjadwal".to_string())
            };
            ui_rows.push(ScheduledItem {
                id: row.id.clone().into(),
                when_label: when.into(),
                text: body.into(),
                failed,
            });
            list.push((row, txt));
        }
        g.scheduled = list;
        on_ui(weak, move |ui| {
            ui.set_scheduled(ModelRc::from(Rc::new(VecModel::from(ui_rows))));
        });
    }
}

pub(crate) fn wire_chat_callbacks(
    window: &MainWindow,
    rt: &Arc<Runtime>,
    state: &Arc<Mutex<AppState>>,
) {
    let weak = window.as_weak();
    let rt_c = rt.clone();
    let st_c = state.clone();
    window.on_back_to_list(move || {
        let w = weak.clone();
        let s = st_c.clone();
        rt_c.spawn(async move {
            let notify = {
                let mut g = s.lock().await;
                if let Some(prev) = g.active_conv.take() {
                    if let Some(ref rt) = g.realtime {
                        rt.close_conversation(&prev.id);
                    }
                }
                g.notify_enabled
            };
            platform::set_notification_presence(notify, true, None);
            on_ui(&w, |ui| {
                ui.set_screen("chat_list".into());
                ui.set_selected_bubble_key(SharedString::default());
            });
            crate::controller::load_conversations_and_previews(&w, &s).await;
        });
    });

    let weak = window.as_weak();
    let rt_c = rt.clone();
    let st_c = state.clone();
    window.on_draft_edited(move |txt| {
        if txt.is_empty() {
            return;
        }
        let s = st_c.clone();
        rt_c.spawn(async move {
            let g = s.lock().await;
            if let (Some(ref conv), Some(ref rt)) = (&g.active_conv, &g.realtime) {
                rt.notify_typing(&conv.id);
            }
        });
        let _ = &weak;
    });

    let weak = window.as_weak();
    let rt_c = rt.clone();
    let st_c = state.clone();
    window.on_send_message(move |raw_text| {
        let text = raw_text.trim().to_string();
        if text.is_empty() {
            return;
        }
        if let Some(ui) = weak.upgrade() {
            ui.set_draft(SharedString::default());
            ui.set_chat_error(SharedString::default());
        }
        let w = weak.clone();
        let s = st_c.clone();
        rt_c.spawn(async move {
            let (conv, my_id, my_ver, ring, rpc, vault, reply_to) = {
                let mut g = state_lock(&s).await;
                let Some(conv) = g.active_conv.clone() else {
                    return;
                };
                let Some(me) = g.client.me.clone() else {
                    return;
                };
                let Some(ring) = g.client.keyring.clone() else {
                    return;
                };
                let Some(ver) = me.key_version else {
                    return;
                };
                let rep = g.reply_to_id.take();
                (
                    conv,
                    me.id,
                    ver,
                    ring,
                    g.client.rpc.clone(),
                    g.client.vault.clone(),
                    rep,
                )
            };
            on_ui(&w, |ui| {
                ui.set_reply_target_snippet(SharedString::default())
            });

            let sealed = {
                let mut g = s.lock().await;
                let Some(pk) = g.e2ee.latest_active_key(&conv.peer_id).cloned() else {
                    on_ui(&w, |ui| {
                        ui.set_chat_error("Kunci lawan belum tersedia.".into())
                    });
                    return;
                };
                match g.e2ee.seal_text(
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
                    &text,
                    reply_to,
                    None,
                ) {
                    Ok(s) => s,
                    Err(e) => {
                        let msg = e.to_string();
                        on_ui(&w, move |ui| ui.set_chat_error(msg.into()));
                        return;
                    }
                }
            };

            let queued_at = now_iso_utc();
            match send_with_offline_time(&rpc, &sealed, &queued_at).await {
                Ok(res) if res.ok => {
                    let msg = ChatMessage {
                        id: res.id.unwrap_or_else(|| sealed.p_client_msg_id.clone()),
                        conversation_id: conv.id.clone(),
                        sender_id: Some(my_id.clone()),
                        seq: res.seq.unwrap_or(0),
                        client_msg_id: sealed.p_client_msg_id,
                        kind: sealed.p_kind,
                        ciphertext: Some(sealed.p_ciphertext),
                        nonce: Some(sealed.p_nonce),
                        sender_key_version: sealed.p_sender_key_version,
                        recipient_key_version: sealed.p_recipient_key_version,
                        reply_to: sealed.p_reply_to,
                        created_at: res.created_at.unwrap_or_else(|| queued_at.clone()),
                        offline_sent_at: res.offline_sent_at,
                        edited_at: None,
                        deleted_at: None,
                        expires_at: None,
                    };
                    let _ = vault.save_messages(&my_id, &conv.id, std::slice::from_ref(&msg));
                    {
                        let mut g = s.lock().await;
                        g.all_messages = merge_cached_messages(&g.all_messages, &[msg], None, 0);
                    }
                    sync_bubbles_to_ui(&w, &s).await;
                }
                Ok(res) => {
                    let msg = send_error_message(res.code.as_deref().unwrap_or(""))
                        .unwrap_or("Pesan gagal dikirim")
                        .to_string();
                    on_ui(&w, move |ui| ui.set_chat_error(msg.into()));
                }
                Err(e) if e.is_network_like() => {
                    let _ = queue_message(
                        &vault,
                        &my_id,
                        QueuedMessage {
                            conversation_id: conv.id,
                            params: sealed,
                            queued_at,
                        },
                    );
                    on_ui(&w, |ui| ui.set_offline(true));
                    sync_bubbles_to_ui(&w, &s).await;
                }
                Err(e) => {
                    let msg = e.user_message("Pesan gagal dikirim");
                    on_ui(&w, move |ui| ui.set_chat_error(msg.into()));
                }
            }
        });
    });

    let weak = window.as_weak();
    let rt_c = rt.clone();
    let st_c = state.clone();
    window.on_load_older(move || {
        let w = weak.clone();
        let s = st_c.clone();
        on_ui(&w, |ui| ui.set_loading_older(true));
        rt_c.spawn(async move {
            let (conv_id, my_id, before_seq, rpc, vault) = {
                let g = s.lock().await;
                let before = oldest_persisted_seq(&g.bubbles);
                (
                    g.active_conv
                        .as_ref()
                        .map(|c| c.id.clone())
                        .unwrap_or_default(),
                    g.client
                        .me
                        .as_ref()
                        .map(|m| m.id.clone())
                        .unwrap_or_default(),
                    before,
                    g.client.rpc.clone(),
                    g.client.vault.clone(),
                )
            };
            if let Some(bseq) = before_seq {
                if let Ok(rows) = rpc.get_messages(&conv_id, Some(bseq), CHAT_PAGE_SIZE).await {
                    let exhausted = rows.len() < CHAT_PAGE_SIZE;
                    let _ = vault.save_messages(&my_id, &conv_id, &rows);
                    let mut g = s.lock().await;
                    g.server_exhausted = exhausted;
                    g.all_messages = merge_cached_messages(&g.all_messages, &rows, None, 0);
                }
            }
            on_ui(&w, |ui| ui.set_loading_older(false));
            sync_bubbles_to_ui(&w, &s).await;
        });
    });

    let weak = window.as_weak();
    let rt_c = rt.clone();
    let st_c = state.clone();
    window.on_reply_message(move |key| {
        let w = weak.clone();
        let s = st_c.clone();
        let k = key.to_string();
        rt_c.spawn(async move {
            let mut g = s.lock().await;
            if let Some((sid, snip)) =
                g.bubbles
                    .iter()
                    .find(|b| b.item.key.as_str() == k)
                    .map(|b| {
                        (
                            b.item.server_id.to_string(),
                            reply_snippet(Some(b.item.text.as_str()), b.item.deleted),
                        )
                    })
            {
                g.reply_to_id = Some(sid);
                on_ui(&w, move |ui| ui.set_reply_target_snippet(snip.into()));
            }
        });
    });

    let weak = window.as_weak();
    let rt_c = rt.clone();
    let st_c = state.clone();
    window.on_cancel_reply(move || {
        let w = weak.clone();
        let s = st_c.clone();
        rt_c.spawn(async move {
            s.lock().await.reply_to_id = None;
            on_ui(&w, |ui| {
                ui.set_reply_target_snippet(SharedString::default())
            });
        });
    });

    let weak = window.as_weak();
    let rt_c = rt.clone();
    let st_c = state.clone();
    window.on_pin_toggle(move |key| {
        let w = weak.clone();
        let s = st_c.clone();
        let k = key.to_string();
        rt_c.spawn(async move {
            {
                let mut g = s.lock().await;
                let Some(conv_id) = g.active_conv.as_ref().map(|c| c.id.clone()) else {
                    return;
                };
                let my_id = g
                    .client
                    .me
                    .as_ref()
                    .map(|m| m.id.clone())
                    .unwrap_or_default();
                if g.pins.iter().any(|p| p == &k) {
                    g.pins = remove_pin(&g.pins, &k);
                } else {
                    g.pins = add_pin(&g.pins, &k);
                }
                let json = serde_json::to_string(&g.pins).unwrap_or_else(|_| "[]".into());
                let _ = g
                    .client
                    .vault
                    .set_secret(&pins_storage_key(&my_id, &conv_id), &json);
            }
            sync_bubbles_to_ui(&w, &s).await;
        });
    });

    let weak = window.as_weak();
    let rt_c = rt.clone();
    let st_c = state.clone();
    window.on_delete_message(move |key| {
        let w = weak.clone();
        let s = st_c.clone();
        let k = key.to_string();
        rt_c.spawn(async move {
            let (msg_id, raw_msg, conv_id, my_id, rpc, vault) = {
                let g = s.lock().await;
                let found = g.bubbles.iter().find(|b| b.item.key.as_str() == k);
                (
                    found
                        .map(|b| b.item.server_id.to_string())
                        .unwrap_or_default(),
                    found.and_then(|b| b.raw_msg.clone()),
                    g.active_conv
                        .as_ref()
                        .map(|c| c.id.clone())
                        .unwrap_or_default(),
                    g.client
                        .me
                        .as_ref()
                        .map(|m| m.id.clone())
                        .unwrap_or_default(),
                    g.client.rpc.clone(),
                    g.client.vault.clone(),
                )
            };
            if msg_id.is_empty() {
                return;
            }
            if let Ok(true) = rpc.delete_message(&msg_id).await {
                if let Some(raw) = raw_msg {
                    let del = ChatMessage {
                        ciphertext: None,
                        nonce: None,
                        deleted_at: Some(now_iso_utc()),
                        ..raw
                    };
                    let _ = vault.save_messages(&my_id, &conv_id, std::slice::from_ref(&del));
                    let mut g = s.lock().await;
                    g.all_messages = merge_cached_messages(&g.all_messages, &[del], None, 0);
                }
                sync_bubbles_to_ui(&w, &s).await;
            }
        });
    });

    let weak = window.as_weak();
    let rt_c = rt.clone();
    let st_c = state.clone();
    window.on_accept_request(move || {
        let w = weak.clone();
        let s = st_c.clone();
        rt_c.spawn(async move {
            let (conv_id, rpc) = {
                let g = s.lock().await;
                (
                    g.active_conv
                        .as_ref()
                        .map(|c| c.id.clone())
                        .unwrap_or_default(),
                    g.client.rpc.clone(),
                )
            };
            if let Ok(true) = rpc.accept_chat(&conv_id).await {
                if let Some(ref mut conv) = s.lock().await.active_conv {
                    conv.status = ConversationStatus::Accepted;
                }
                on_ui(&w, |ui| ui.set_active_incoming_request(false));
            }
        });
    });

    let weak = window.as_weak();
    let rt_c = rt.clone();
    let st_c = state.clone();
    window.on_toggle_block(move || {
        let w = weak.clone();
        let s = st_c.clone();
        rt_c.spawn(async move {
            let (peer_id, currently_blocked, rpc) = {
                let g = s.lock().await;
                let Some(ref conv) = g.active_conv else {
                    return;
                };
                (
                    conv.peer_id.clone(),
                    conv.peer_blocked,
                    g.client.rpc.clone(),
                )
            };
            if rpc.set_blocked(&peer_id, !currently_blocked).await.is_ok() {
                if let Some(ref mut conv) = s.lock().await.active_conv {
                    conv.peer_blocked = !currently_blocked;
                }
                on_ui(&w, move |ui| ui.set_active_peer_blocked(!currently_blocked));
            }
        });
    });

    let weak = window.as_weak();
    let rt_c = rt.clone();
    let st_c = state.clone();
    window.on_trust_new_key(move || {
        let w = weak.clone();
        let s = st_c.clone();
        rt_c.spawn(async move {
            let g = s.lock().await;
            let Some(ref conv) = g.active_conv else {
                return;
            };
            let peer_id = conv.peer_id.clone();
            let my_id = g
                .client
                .me
                .as_ref()
                .map(|m| m.id.clone())
                .unwrap_or_default();
            if let Some(latest) = g.e2ee.latest_active_key(&peer_id).cloned() {
                let _ = g
                    .client
                    .vault
                    .save_tofu(&my_id, &peer_id, &latest.public_key);
                on_ui(&w, |ui| ui.set_key_changed(false));
            }
        });
    });

    let weak = window.as_weak();
    let rt_c = rt.clone();
    let st_c = state.clone();
    window.on_clear_local_chat(move || {
        let w = weak.clone();
        let s = st_c.clone();
        rt_c.spawn(async move {
            {
                let mut g = s.lock().await;
                let Some(ref conv) = g.active_conv else {
                    return;
                };
                let my_id = g
                    .client
                    .me
                    .as_ref()
                    .map(|m| m.id.clone())
                    .unwrap_or_default();
                let max_seq = g
                    .bubbles
                    .iter()
                    .filter(|b| !b.item.pending)
                    .map(|b| b.item.seq as i64)
                    .max()
                    .unwrap_or(0);
                let _ = g.client.vault.clear_conversation(&my_id, &conv.id, max_seq);
                g.all_messages.clear();
                g.bubbles.clear();
            }
            sync_bubbles_to_ui(&w, &s).await;
        });
    });

    let weak = window.as_weak();
    let rt_c = rt.clone();
    let st_c = state.clone();
    window.on_search_local_messages(move |q| {
        let w = weak.clone();
        let s = st_c.clone();
        let query = q.to_string();
        rt_c.spawn(async move {
            let hits: Vec<SearchHitItem> = {
                let g = s.lock().await;
                let searchable: Vec<SearchableMessage> = g
                    .bubbles
                    .iter()
                    .map(|b| SearchableMessage {
                        key: b.item.key.to_string(),
                        seq: b.item.seq as i64,
                        created_at: b
                            .raw_msg
                            .as_ref()
                            .map(|m| m.created_at.clone())
                            .unwrap_or_default(),
                        text: if b.item.text.is_empty() {
                            None
                        } else {
                            Some(b.item.text.to_string())
                        },
                        deleted: b.item.deleted,
                    })
                    .collect();
                search_messages(&searchable, &query, 40)
                    .into_iter()
                    .map(|h| SearchHitItem {
                        key: h.key.into(),
                        seq: h.seq as i32,
                        time_label: format_clock(Some(&h.created_at)).into(),
                        before: h.before.into(),
                        match_text: h.match_text.into(),
                        after: h.after.into(),
                    })
                    .collect()
            };
            on_ui(&w, move |ui| {
                ui.set_search_hits(ModelRc::from(Rc::new(VecModel::from(hits))));
            });
        });
    });

    let weak = window.as_weak();
    let rt_c = rt.clone();
    let st_c = state.clone();
    window.on_jump_to_message(move |key| {
        let w = weak.clone();
        let s = st_c.clone();
        let target_key = key.to_string();
        rt_c.spawn(async move {
            let pos = {
                s.lock()
                    .await
                    .bubbles
                    .iter()
                    .position(|b| b.item.key.as_str() == target_key)
            };
            if let Some(row) = pos {
                on_ui(&w, move |ui| {
                    ui.set_selected_bubble_key(target_key.into());
                    ui.invoke_scroll_chat_to_row(row as i32);
                });
            }
        });
    });

    let weak = window.as_weak();
    let rt_c = rt.clone();
    let st_c = state.clone();
    window.on_schedule_preset(move |idx| {
        let w = weak.clone();
        let s = st_c.clone();
        rt_c.spawn(async move {
            let presets = schedule_presets(Local::now());
            if let Some(preset) = presets.get(idx as usize) {
                schedule_draft_at(&w, &s, preset.at).await;
            }
        });
    });

    let weak = window.as_weak();
    let rt_c = rt.clone();
    let st_c = state.clone();
    window.on_schedule_clock_submit(move |clock_str| {
        let w = weak.clone();
        let s = st_c.clone();
        let raw = clock_str.to_string();
        rt_c.spawn(async move {
            let now = Local::now();
            let Some(at) = parse_clock_input(&raw, now) else {
                on_ui(&w, |ui| {
                    ui.set_schedule_error("Format jam: mis. 9.30 atau 20.00".into());
                });
                return;
            };
            match validate_schedule_time(at, now) {
                Some(ScheduleProblem::TooSoon) => {
                    on_ui(&w, |ui| {
                        ui.set_schedule_error("Pilih waktu minimal 1 menit dari sekarang.".into());
                    });
                }
                Some(ScheduleProblem::TooFar) => {
                    on_ui(&w, |ui| {
                        ui.set_schedule_error("Maksimal 30 hari ke depan.".into());
                    });
                }
                None => {
                    schedule_draft_at(&w, &s, at).await;
                }
            }
        });
    });

    let weak = window.as_weak();
    let rt_c = rt.clone();
    let st_c = state.clone();
    window.on_cancel_scheduled(move |id| {
        let w = weak.clone();
        let s = st_c.clone();
        let sid = id.to_string();
        rt_c.spawn(async move {
            let rpc = { s.lock().await.client.rpc.clone() };
            if rpc.cancel_scheduled(&sid).await.is_ok() {
                load_scheduled_ui(&w, &s).await;
            }
        });
    });

    let weak = window.as_weak();
    let rt_c = rt.clone();
    let st_c = state.clone();
    window.on_attach_file(move || {
        if !platform::request_pick_files() {
            on_ui(&weak, |ui| {
                ui.set_chat_error(
                    "Pemilih dokumen hanya tersedia pada build Android Gradle.".into(),
                );
            });
        }
        let _ = (&rt_c, &st_c);
    });

    let weak = window.as_weak();
    let rt_c = rt.clone();
    let st_c = state.clone();
    window.on_file_action(move |key| {
        let w = weak.clone();
        let s = st_c.clone();
        let k = key.to_string();
        rt_c.spawn(async move {
            let (file, saved_path, api_base, token) = {
                let g = s.lock().await;
                let found = g.bubbles.iter().find(|b| b.item.key.as_str() == k);
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
                    found.and_then(|b| b.file.clone()),
                    found
                        .map(|b| b.item.saved_path.to_string())
                        .unwrap_or_default(),
                    g.client.env.api_base_url.clone(),
                    tok,
                )
            };
            let Some(file) = file else { return };
            if !saved_path.is_empty() {
                if is_voice_file(&file.mime) {
                    platform::play_voice_file(&saved_path);
                } else {
                    platform::open_saved_file(&saved_path, &file.mime);
                }
                return;
            }
            match platform::download_and_save_file(&file, &api_base, &token) {
                Ok(uri) => {
                    if is_voice_file(&file.mime) {
                        platform::play_voice_file(&uri);
                    } else {
                        {
                            let mut g = s.lock().await;
                            if let Some(b) = g.bubbles.iter_mut().find(|b| b.item.key.as_str() == k)
                            {
                                b.item.saved_path = uri.clone().into();
                            }
                            let ui_items: Vec<BubbleItem> =
                                g.bubbles.iter().map(|b| b.item.clone()).collect();
                            on_ui(&w, move |ui| {
                                ui.set_messages(ModelRc::from(Rc::new(VecModel::from(ui_items))));
                            });
                        }
                        platform::open_saved_file(&uri, &file.mime);
                    }
                }
                Err(err) => {
                    on_ui(&w, move |ui| ui.set_chat_error(err.into()));
                }
            }
        });
    });

    let weak = window.as_weak();
    let rt_c = rt.clone();
    let st_c = state.clone();
    window.on_cycle_call_quality(move || {
        let w = weak.clone();
        let s = st_c.clone();
        rt_c.spawn(async move {
            let next_label = {
                let mut g = s.lock().await;
                let next = g.call_quality.next();
                g.call_quality = next;
                if let Some(ref conv) = g.active_conv {
                    let _ = g
                        .client
                        .vault
                        .set_secret(&call_quality_key(&conv.id), next.as_str());
                }
                next.option().label
            };
            on_ui(&w, move |ui| ui.set_call_quality_label(next_label.into()));
        });
    });
}

async fn schedule_draft_at(
    weak: &Weak<MainWindow>,
    state: &Arc<Mutex<AppState>>,
    send_at: chrono::DateTime<Local>,
) {
    let draft_text = {
        let (tx, rx) = tokio::sync::oneshot::channel();
        let w = weak.clone();
        let _ = slint::invoke_from_event_loop(move || {
            let val = w
                .upgrade()
                .map(|u| u.get_draft().to_string())
                .unwrap_or_default();
            let _ = tx.send(val);
        });
        rx.await.unwrap_or_default()
    };
    let clean = draft_text.trim().to_string();
    if clean.is_empty() {
        return;
    }

    let (conv, my_id, my_ver, ring, rpc, reply_to) = {
        let mut g = state.lock().await;
        let Some(conv) = g.active_conv.clone() else {
            return;
        };
        let Some(me) = g.client.me.clone() else {
            return;
        };
        let Some(ring) = g.client.keyring.clone() else {
            return;
        };
        let Some(ver) = me.key_version else {
            return;
        };
        (
            conv,
            me.id,
            ver,
            ring,
            g.client.rpc.clone(),
            g.reply_to_id.take(),
        )
    };

    let sealed = {
        let mut g = state.lock().await;
        let Some(pk) = g.e2ee.latest_active_key(&conv.peer_id).cloned() else {
            return;
        };
        match g.e2ee.seal_text(
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
            &clean,
            reply_to.clone(),
            None,
        ) {
            Ok(s) => s,
            Err(_) => return,
        }
    };

    let params = serde_json::json!({
        "p_conversation_id": sealed.p_conversation_id,
        "p_client_msg_id": sealed.p_client_msg_id,
        "p_ciphertext": sealed.p_ciphertext,
        "p_nonce": sealed.p_nonce,
        "p_sender_key_version": sealed.p_sender_key_version,
        "p_recipient_key_version": sealed.p_recipient_key_version,
        "p_send_at": send_at.to_utc().to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
        "p_reply_to": reply_to,
    });
    match rpc.schedule_message(&params).await {
        Ok(res) if res.ok => {
            on_ui(weak, |ui| {
                ui.set_draft(SharedString::default());
                ui.set_schedule_error(SharedString::default());
                ui.set_reply_target_snippet(SharedString::default());
            });
            load_scheduled_ui(weak, state).await;
        }
        Ok(res) => {
            let msg = schedule_error_message(res.code.as_deref().unwrap_or(""));
            on_ui(weak, move |ui| ui.set_schedule_error(msg.into()));
        }
        Err(_) => {
            on_ui(weak, |ui| {
                ui.set_schedule_error("Gagal menjadwalkan pesan.".into());
            });
        }
    }
}

async fn state_lock(state: &Arc<Mutex<AppState>>) -> tokio::sync::MutexGuard<'_, AppState> {
    state.lock().await
}
