//! Controller aplikasi Slint <-> `seru24-core` + event loop async (`tokio`).

use std::collections::HashMap;
use std::rc::Rc;
use std::sync::Arc;

use seru24_core::api::{AccountStatus, RegisterOutcome, SeruClient};
use seru24_core::app_release::{is_newer_rust_release, parse_app_release, AppRelease};
use seru24_core::call_core::CallStateMachine;
use seru24_core::call_quality::CallQuality;
use seru24_core::chat::{
    append_conversations, avatar_rgb, format_time, is_incoming_request, peer_label, BubbleOrder,
    Conversation, ListConversationsOptions, CONVERSATION_PAGE_SIZE,
};
use seru24_core::e2ee::{ChatMessage, E2eeEngine, PublicKeyRow};
use seru24_core::env::AppEnv;
use seru24_core::file::FileMessageBody;
use seru24_core::outbox::flush_outbox;
use seru24_core::preview::{preview_text, Preview};
use seru24_core::realtime::{InboxEventKind, RealtimeEvent, RealtimeHandle};
use seru24_core::schedule::ScheduledRow;
use seru24_core::storage::LocalVault;
use slint::{Color, ComponentHandle, ModelRc, SharedString, VecModel, Weak};
use tokio::runtime::Runtime;
use tokio::sync::{mpsc, Mutex};

use crate::platform::{self, PlatformEvent};
use crate::{
    BubbleItem, ChatItem, FoundUserItem, MainWindow, NearbyMsgItem, NearbyPeerItem, Theme,
};

pub mod chat_ctrl;
pub mod extra_ctrl;

pub(crate) fn avatar_color(seed: &str) -> Color {
    let (r, g, b) = avatar_rgb(seed);
    Color::from_rgb_u8(r, g, b)
}

#[derive(Clone)]
pub(crate) struct UiBubble {
    pub(crate) item: BubbleItem,
    pub(crate) raw_msg: Option<ChatMessage>,
    pub(crate) file: Option<FileMessageBody>,
}

impl BubbleOrder for UiBubble {
    fn key(&self) -> &str {
        self.item.key.as_str()
    }
    fn seq(&self) -> i64 {
        self.item.seq as i64
    }
    fn pending(&self) -> bool {
        self.item.pending
    }
    fn created_at(&self) -> Option<&str> {
        self.raw_msg
            .as_ref()
            .map(|m| seru24_core::chat::message_time(&m.created_at, m.offline_sent_at.as_deref()))
    }
    fn revised(&self) -> bool {
        self.item.revised
    }
}

pub(crate) struct AppState {
    pub(crate) client: SeruClient,
    pub(crate) e2ee: E2eeEngine,
    pub(crate) realtime: Option<RealtimeHandle>,
    pub(crate) conversations: Vec<Conversation>,
    pub(crate) filtered_query: String,
    pub(crate) active_conv: Option<Conversation>,
    pub(crate) all_messages: Vec<ChatMessage>,
    pub(crate) bubbles: Vec<UiBubble>,
    pub(crate) peer_read_seq: i64,
    pub(crate) has_older: bool,
    pub(crate) server_exhausted: bool,
    pub(crate) reply_to_id: Option<String>,
    pub(crate) pins: Vec<String>,
    pub(crate) scheduled: Vec<(ScheduledRow, Option<String>)>,
    pub(crate) call_sm: CallStateMachine,
    pub(crate) call_quality: CallQuality,
    pub(crate) call_muted: bool,
    pub(crate) call_speaker: bool,
    pub(crate) latest_release: Option<AppRelease>,
    pub(crate) radar_on: bool,
    pub(crate) standby_enabled: bool,
    pub(crate) conversations_has_more: bool,
    pub(crate) pending_backup_import: bool,
    pub(crate) nearby_peers: Vec<NearbyPeerItem>,
    pub(crate) nearby_endpoint_names: HashMap<String, String>,
    pub(crate) nearby_keys: HashMap<String, Vec<PublicKeyRow>>,
    pub(crate) nearby_messages_by_user: HashMap<String, Vec<NearbyMsgItem>>,
    pub(crate) active_nearby_user_id: Option<String>,
    pub(crate) notify_enabled: bool,
}

fn open_app_vault() -> LocalVault {
    let path = platform::vault_db_path();
    if let Some(mk) = platform::call_master_key() {
        if let Ok(v) = LocalVault::open_with_master_key(&path, mk) {
            return v;
        }
    }
    LocalVault::open_desktop(&path)
        .unwrap_or_else(|_| LocalVault::open_in_memory().expect("SQLite in-memory harus tersedia"))
}

pub fn initials_of(name: &str) -> String {
    let collected: String = name
        .split(|c: char| c.is_whitespace() || c == '_')
        .filter_map(|p| p.chars().next())
        .take(2)
        .map(|c| c.to_ascii_uppercase())
        .collect();
    if collected.is_empty() {
        "?".to_string()
    } else {
        collected
    }
}

pub(crate) fn app_version_code() -> u64 {
    env!("CARGO_PKG_VERSION_PATCH").parse::<u64>().unwrap_or(1)
}

pub(crate) fn on_ui(weak: &Weak<MainWindow>, f: impl FnOnce(MainWindow) + Send + 'static) {
    let weak = weak.clone();
    let _ = slint::invoke_from_event_loop(move || {
        if let Some(ui) = weak.upgrade() {
            f(ui);
        }
    });
}

pub(crate) fn filtered_chat_items(
    convs: &[Conversation],
    query: &str,
    my_id: &str,
    vault: &LocalVault,
) -> Vec<ChatItem> {
    let needle = query.trim().trim_start_matches('@').to_lowercase();
    convs
        .iter()
        .filter(|c| {
            needle.is_empty()
                || c.peer_display_name.to_lowercase().contains(&needle)
                || c.peer_username.to_lowercase().contains(&needle)
        })
        .map(|c| {
            let name = peer_label(&c.peer_display_name, &c.peer_username);
            let preview = vault
                .load_preview(my_id, &c.id)
                .ok()
                .flatten()
                .map(|p| p.text)
                .unwrap_or_else(|| {
                    if is_incoming_request(c, Some(my_id)) {
                        "Permintaan chat baru".to_string()
                    } else {
                        "Ketuk untuk membuka chat".to_string()
                    }
                });
            ChatItem {
                id: SharedString::from(c.id.as_str()),
                name: SharedString::from(name.as_str()),
                username: SharedString::from(c.peer_username.as_str()),
                initials: SharedString::from(initials_of(&name)),
                avatar_color: avatar_color(&c.peer_username),
                preview: SharedString::from(preview),
                time: SharedString::from(format_time(c.last_message_at.as_deref())),
                unread: c.unread as i32,
                pinned: c.pinned,
                incoming_request: is_incoming_request(c, Some(my_id)),
                blocked: c.peer_blocked,
            }
        })
        .collect()
}

pub(crate) async fn refresh_chat_list_ui(weak: &Weak<MainWindow>, state: &Arc<Mutex<AppState>>) {
    let items = {
        let st = state.lock().await;
        let my_id = st.client.me.as_ref().map(|m| m.id.as_str()).unwrap_or("");
        filtered_chat_items(
            &st.conversations,
            &st.filtered_query,
            my_id,
            &st.client.vault,
        )
    };
    on_ui(weak, move |ui| {
        ui.set_chats(ModelRc::from(Rc::new(VecModel::from(items))));
    });
}

pub fn start_ui(window: &MainWindow) {
    let rt = Arc::new(
        tokio::runtime::Builder::new_multi_thread()
            .enable_all()
            .build()
            .expect("gagal membuat tokio runtime"),
    );

    let vault = open_app_vault();
    let saved_theme = vault
        .get_secret("seru24.theme")
        .ok()
        .flatten()
        .map(|s| s.to_string())
        .unwrap_or_else(|| "system".to_string());
    let theme_global = window.global::<Theme<'_>>();
    theme_global.set_system_dark(platform::is_system_dark_mode());
    theme_global.invoke_set_mode(saved_theme.into());

    let notify_enabled = vault
        .get_secret("notifications")
        .ok()
        .flatten()
        .map(|s| s.as_str() == "on")
        .unwrap_or(false);
    let standby_enabled = vault
        .get_secret("standby")
        .ok()
        .flatten()
        .map(|s| s.as_str() == "on")
        .unwrap_or(false);
    window.set_standby_enabled(standby_enabled);

    let env = AppEnv::from_build();
    let client = SeruClient::new(
        env,
        vault.clone(),
        "android",
        platform::device_display_name(),
    )
    .expect("gagal membuat SeruClient");

    let state = Arc::new(Mutex::new(AppState {
        client,
        e2ee: E2eeEngine::new(),
        realtime: None,
        conversations: Vec::new(),
        filtered_query: String::new(),
        active_conv: None,
        all_messages: Vec::new(),
        bubbles: Vec::new(),
        peer_read_seq: 0,
        has_older: false,
        server_exhausted: false,
        reply_to_id: None,
        pins: Vec::new(),
        scheduled: Vec::new(),
        call_sm: CallStateMachine::new(""),
        call_quality: CallQuality::Standar,
        call_muted: false,
        call_speaker: false,
        latest_release: None,
        radar_on: false,
        standby_enabled,
        conversations_has_more: false,
        pending_backup_import: false,
        nearby_peers: Vec::new(),
        nearby_endpoint_names: HashMap::new(),
        nearby_keys: HashMap::new(),
        nearby_messages_by_user: HashMap::new(),
        active_nearby_user_id: None,
        notify_enabled,
    }));

    let (plat_tx, mut plat_rx) = mpsc::unbounded_channel::<PlatformEvent>();
    platform::install_event_channel(plat_tx);

    let vault_theme = vault.clone();
    window.global::<Theme<'_>>().on_mode_changed(move |mode| {
        let _ = vault_theme.set_secret("seru24.theme", mode.as_str());
    });

    wire_callbacks(window, &rt, &state);

    let weak = window.as_weak();
    let state_boot = state.clone();
    let rt_boot = rt.clone();
    rt.spawn(async move {
        let weak_plat = weak.clone();
        let state_plat = state_boot.clone();
        let rt_plat = rt_boot.clone();
        tokio::spawn(async move {
            while let Some(ev) = plat_rx.recv().await {
                extra_ctrl::handle_platform_event(&weak_plat, &state_plat, &rt_plat, ev).await;
            }
        });
        restore_and_boot(&weak, &state_boot, &rt_boot).await;
    });
}

fn wire_callbacks(window: &MainWindow, rt: &Arc<Runtime>, state: &Arc<Mutex<AppState>>) {
    let weak = window.as_weak();
    let rt_c = rt.clone();
    let st_c = state.clone();
    window.on_submit_login(move || {
        let Some(ui) = weak.upgrade() else { return };
        let ident = ui.get_auth_identifier().to_string();
        let pw = ui.get_auth_password().to_string();
        let w = weak.clone();
        let s = st_c.clone();
        let rt_inner = rt_c.clone();
        ui.set_auth_busy(true);
        ui.set_auth_error(SharedString::default());
        rt_c.spawn(async move {
            let res = {
                let mut guard = s.lock().await;
                guard.client.login_and_unlock(&ident, &pw).await
            };
            match res {
                Ok(AccountStatus::Ready) => {
                    on_ui(&w, |u| {
                        u.set_auth_busy(false);
                        u.set_auth_password(SharedString::default());
                    });
                    enter_signed_in(&w, &s, &rt_inner).await;
                }
                Ok(_) => {
                    on_ui(&w, |u| {
                        u.set_auth_busy(false);
                        u.set_auth_error("Kunci chat belum dapat dibuka.".into());
                    });
                }
                Err(e) => {
                    let msg = e.user_message("Login gagal. Periksa email/username dan password.");
                    on_ui(&w, move |u| {
                        u.set_auth_busy(false);
                        u.set_auth_error(msg.into());
                    });
                }
            }
        });
    });

    let weak = window.as_weak();
    let rt_c = rt.clone();
    let st_c = state.clone();
    window.on_submit_register(move || {
        let Some(ui) = weak.upgrade() else { return };
        let email = ui.get_auth_email().to_string();
        let username = ui.get_auth_username().to_string().trim().to_lowercase();
        let display_name = ui.get_auth_display_name().to_string();
        let pw = ui.get_auth_password().to_string();
        let confirm = ui.get_auth_confirm().to_string();
        let min_len = st_c.blocking_lock().client.env.password_min_length;
        let valid_user = (3..=30).contains(&username.len())
            && username
                .bytes()
                .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'_');
        if !valid_user {
            ui.set_auth_error("Username 3-30 karakter: huruf kecil, angka, atau _".into());
            return;
        }
        if pw.chars().count() < min_len {
            ui.set_auth_error(format!("Password minimal {min_len} karakter").into());
            return;
        }
        if pw != confirm {
            ui.set_auth_error("Konfirmasi password tidak sama".into());
            return;
        }
        ui.set_auth_busy(true);
        ui.set_auth_error(SharedString::default());
        ui.set_auth_notice(SharedString::default());
        let w = weak.clone();
        let s = st_c.clone();
        let rt_inner = rt_c.clone();
        rt_c.spawn(async move {
            let reg_res = {
                let guard = s.lock().await;
                guard
                    .client
                    .session
                    .register_account(&email, &username, &display_name, &pw)
                    .await
            };
            match reg_res {
                Ok(RegisterOutcome::VerifyEmail) => {
                    on_ui(&w, |u| {
                        u.set_auth_busy(false);
                        u.set_auth_register_mode(false);
                        u.set_auth_notice(
                            "Tautan verifikasi dikirim ke email. Buka tautan itu, lalu masuk."
                                .into(),
                        );
                    });
                }
                Ok(RegisterOutcome::Active(mat)) => {
                    let boot = {
                        let mut guard = s.lock().await;
                        guard.client.set_pending_key_material(mat);
                        guard.client.bootstrap_account(true).await
                    };
                    match boot {
                        Ok(AccountStatus::Ready) => {
                            on_ui(&w, |u| {
                                u.set_auth_busy(false);
                                u.set_auth_password(SharedString::default());
                                u.set_auth_confirm(SharedString::default());
                            });
                            enter_signed_in(&w, &s, &rt_inner).await;
                        }
                        _ => {
                            on_ui(&w, |u| {
                                u.set_auth_busy(false);
                                u.set_auth_error("Gagal menyiapkan kunci chat.".into());
                            });
                        }
                    }
                }
                Err(e) => {
                    let msg = e.user_message("Pendaftaran gagal. Coba lagi.");
                    on_ui(&w, move |u| {
                        u.set_auth_busy(false);
                        u.set_auth_error(msg.into());
                    });
                }
            }
        });
    });

    let weak = window.as_weak();
    let rt_c = rt.clone();
    let st_c = state.clone();
    window.on_search_changed(move |q| {
        let w = weak.clone();
        let s = st_c.clone();
        let query = q.to_string();
        rt_c.spawn(async move {
            {
                let mut guard = s.lock().await;
                guard.filtered_query = query;
            }
            refresh_chat_list_ui(&w, &s).await;
        });
    });

    let weak = window.as_weak();
    let rt_c = rt.clone();
    let st_c = state.clone();
    window.on_search_username(move |q| {
        let w = weak.clone();
        let s = st_c.clone();
        let query = q.to_string();
        rt_c.spawn(async move {
            if query.trim().is_empty() {
                on_ui(&w, |u| {
                    u.set_has_found(false);
                    u.set_searched_none(false);
                });
                return;
            }
            on_ui(&w, |u| {
                u.set_search_busy(true);
                u.set_has_found(false);
                u.set_searched_none(false);
            });
            let rpc = { s.lock().await.client.rpc.clone() };
            match rpc.search_user(&query).await {
                Ok(rows) => {
                    if let Some(u) = rows.into_iter().next() {
                        let item = FoundUserItem {
                            id: u.id.into(),
                            username: u.username.into(),
                            display_name: u.display_name.into(),
                        };
                        on_ui(&w, move |ui| {
                            ui.set_search_busy(false);
                            ui.set_found_user(item);
                            ui.set_has_found(true);
                        });
                    } else {
                        on_ui(&w, |ui| {
                            ui.set_search_busy(false);
                            ui.set_searched_none(true);
                        });
                    }
                }
                Err(_) => {
                    on_ui(&w, |ui| {
                        ui.set_search_busy(false);
                        ui.set_list_error("Pencarian username gagal.".into());
                    });
                }
            }
        });
    });

    let weak = window.as_weak();
    let rt_c = rt.clone();
    let st_c = state.clone();
    window.on_start_chat_with(move |target_id| {
        let w = weak.clone();
        let s = st_c.clone();
        let target = target_id.to_string();
        rt_c.spawn(async move {
            let rpc = { s.lock().await.client.rpc.clone() };
            if let Ok(Some(conv_id)) = rpc.start_direct_chat(&target).await {
                if let Ok(mut list) = rpc
                    .list_conversations(&ListConversationsOptions {
                        id: Some(conv_id.clone()),
                        ..Default::default()
                    })
                    .await
                {
                    if let Some(conv) = list.pop() {
                        {
                            let mut g = s.lock().await;
                            if !g.conversations.iter().any(|c| c.id == conv.id) {
                                g.conversations.insert(0, conv.clone());
                            }
                        }
                        on_ui(&w, |u| {
                            u.set_has_found(false);
                            u.set_search_query(SharedString::default());
                        });
                        refresh_chat_list_ui(&w, &s).await;
                        chat_ctrl::open_conversation(&w, &s, conv).await;
                    }
                }
            }
        });
    });

    let weak = window.as_weak();
    let rt_c = rt.clone();
    let st_c = state.clone();
    window.on_open_chat(move |item| {
        let w = weak.clone();
        let s = st_c.clone();
        let cid = item.id.to_string();
        rt_c.spawn(async move {
            let conv = {
                s.lock()
                    .await
                    .conversations
                    .iter()
                    .find(|c| c.id == cid)
                    .cloned()
            };
            if let Some(c) = conv {
                chat_ctrl::open_conversation(&w, &s, c).await;
            }
        });
    });

    chat_ctrl::wire_chat_callbacks(window, rt, state);
    extra_ctrl::wire_extra_callbacks(window, rt, state);

    let st_c = state.clone();
    window.on_open_forgot_password(move || {
        let base = st_c.blocking_lock().client.env.api_base_url.clone();
        if !base.is_empty() {
            platform::open_url(&format!("{base}/lupa-password"));
        }
    });

    let weak = window.as_weak();
    let rt_c = rt.clone();
    let st_c = state.clone();
    window.on_toggle_standby(move |on| {
        let w = weak.clone();
        let s = st_c.clone();
        rt_c.spawn(async move {
            {
                let mut g = s.lock().await;
                g.standby_enabled = on;
                let _ = g
                    .client
                    .vault
                    .set_secret("standby", if on { "on" } else { "off" });
            }
            on_ui(&w, move |ui| ui.set_standby_enabled(on));
        });
    });

    let weak = window.as_weak();
    let rt_c = rt.clone();
    let st_c = state.clone();
    window.on_load_more_chats(move || {
        let w = weak.clone();
        let s = st_c.clone();
        on_ui(&w, |ui| ui.set_loading_more_chats(true));
        rt_c.spawn(async move {
            let (rpc, offset, vault, my_id) = {
                let g = s.lock().await;
                (
                    g.client.rpc.clone(),
                    g.conversations.len() as u32,
                    g.client.vault.clone(),
                    g.client
                        .me
                        .as_ref()
                        .map(|m| m.id.clone())
                        .unwrap_or_default(),
                )
            };
            if let Ok(page) = rpc
                .list_conversations(&ListConversationsOptions {
                    limit: Some(CONVERSATION_PAGE_SIZE as u32),
                    offset: Some(offset),
                    id: None,
                })
                .await
            {
                let more = page.len() >= CONVERSATION_PAGE_SIZE;
                {
                    let mut g = s.lock().await;
                    g.conversations = append_conversations(&g.conversations, &page);
                    g.conversations_has_more = more;
                    let _ = vault.save_conversations(&my_id, &g.conversations);
                }
                refresh_chat_list_ui(&w, &s).await;
                on_ui(&w, move |ui| ui.set_has_more_chats(more));
            }
            on_ui(&w, |ui| ui.set_loading_more_chats(false));
        });
    });
}

async fn restore_and_boot(
    weak: &Weak<MainWindow>,
    state: &Arc<Mutex<AppState>>,
    rt: &Arc<Runtime>,
) {
    let cached_loaded = {
        let mut g = state.lock().await;
        let ok = g.client.load_cached_me();
        if ok {
            if let Some(ref me) = g.client.me {
                let id = me.id.clone();
                if let Ok(convs) = g.client.vault.load_conversations(&id) {
                    g.conversations = convs;
                }
            }
        }
        ok
    };

    if cached_loaded {
        sync_profile_header(weak, state).await;
        refresh_chat_list_ui(weak, state).await;
        on_ui(weak, |ui| {
            ui.set_screen("chat_list".into());
        });
    }

    let status = {
        let mut g = state.lock().await;
        g.client.restore_session().await
    };

    match status {
        AccountStatus::Ready => {
            on_ui(weak, |ui| ui.set_offline(false));
            enter_signed_in(weak, state, rt).await;
        }
        AccountStatus::Offline => {
            on_ui(weak, |ui| {
                ui.set_offline(true);
                ui.set_screen("chat_list".into());
            });
            sync_profile_header(weak, state).await;
            refresh_chat_list_ui(weak, state).await;
        }
        _ => {
            on_ui(weak, |ui| {
                ui.set_screen("auth".into());
            });
        }
    }
}

pub(crate) async fn sync_profile_header(weak: &Weak<MainWindow>, state: &Arc<Mutex<AppState>>) {
    let (display, user, initials, color, notify, standby) = {
        let g = state.lock().await;
        let me = g.client.me.as_ref();
        let d = me.map(|m| m.display_name.clone()).unwrap_or_default();
        let u = me.map(|m| m.username.clone()).unwrap_or_default();
        let shown = if d.is_empty() { u.clone() } else { d.clone() };
        (
            d,
            u.clone(),
            initials_of(&shown),
            avatar_color(&u),
            g.notify_enabled,
            g.standby_enabled,
        )
    };
    on_ui(weak, move |ui| {
        ui.set_my_display_name(display.clone().into());
        ui.set_profile_name_draft(display.into());
        ui.set_my_username(user.into());
        ui.set_my_initials(initials.into());
        ui.set_my_avatar_color(color);
        ui.set_notify_enabled(notify);
        ui.set_standby_enabled(standby);
    });
}

pub(crate) async fn enter_signed_in(
    weak: &Weak<MainWindow>,
    state: &Arc<Mutex<AppState>>,
    rt: &Arc<Runtime>,
) {
    sync_profile_header(weak, state).await;
    on_ui(weak, |ui| {
        ui.set_screen("chat_list".into());
    });

    // Jalankan flush outbox offline + sinkronisasi percakapan + Realtime + cek update APK
    let (my_id, supa_url, anon_key, token, notify_on) = {
        let mut g = state.lock().await;
        let uid = g
            .client
            .me
            .as_ref()
            .map(|m| m.id.clone())
            .unwrap_or_default();
        g.call_sm = CallStateMachine::new(uid.clone());
        let tok = g
            .client
            .session
            .get_access_token()
            .await
            .ok()
            .flatten()
            .map(|s| s.to_string())
            .unwrap_or_default();
        (
            uid,
            g.client.env.supabase_url.clone(),
            g.client.env.supabase_anon_key.clone(),
            tok,
            g.notify_enabled,
        )
    };

    if notify_on {
        if let Some(fcm) = platform::request_fcm_token() {
            let rpc = { state.lock().await.client.rpc.clone() };
            let _ = rpc.register_push_token("android", &fcm).await;
        }
    }
    platform::set_notification_presence(notify_on, true, None);

    // Flush offline outbox
    {
        let (vault, rpc) = {
            let g = state.lock().await;
            (g.client.vault.clone(), g.client.rpc.clone())
        };
        let _ = flush_outbox(&vault, &rpc, &my_id).await;
    }

    // Load fresh conversation list + previews
    load_conversations_and_previews(weak, state).await;

    // Start Realtime socket if not already started
    if !supa_url.is_empty() && !token.is_empty() {
        let mut g = state.lock().await;
        if g.realtime.is_none() {
            let (handle, mut ev_rx) = RealtimeHandle::connect(supa_url, anon_key, my_id, token);
            g.realtime = Some(handle);
            let w_rt = weak.clone();
            let s_rt = state.clone();
            rt.spawn(async move {
                while let Some(ev) = ev_rx.recv().await {
                    handle_realtime_event(&w_rt, &s_rt, ev).await;
                }
            });
        }
    }

    // Check APK update khusus varian Rust (`?app=rust` -> seru24-rust.apk)
    let secure = { state.lock().await.client.secure.clone() };
    if let Ok(json_val) = secure
        .get_json::<serde_json::Value>("/api/app/latest?app=rust")
        .await
    {
        if let Some(rel) = parse_app_release(json_val.get("latest").unwrap_or(&json_val)) {
            if is_newer_rust_release(Some(&rel), app_version_code()) {
                let label = format!("Versi baru v{} tersedia", rel.version_name);
                state.lock().await.latest_release = Some(rel);
                on_ui(weak, move |ui| {
                    ui.set_update_label(label.into());
                });
            }
        }
    }
}

pub(crate) async fn load_conversations_and_previews(
    weak: &Weak<MainWindow>,
    state: &Arc<Mutex<AppState>>,
) {
    let (rpc, vault, my_id, keyring) = {
        let g = state.lock().await;
        (
            g.client.rpc.clone(),
            g.client.vault.clone(),
            g.client
                .me
                .as_ref()
                .map(|m| m.id.clone())
                .unwrap_or_default(),
            g.client.keyring.clone(),
        )
    };
    if my_id.is_empty() {
        return;
    }

    on_ui(weak, |ui| ui.set_syncing(true));
    match rpc
        .list_conversations(&ListConversationsOptions {
            limit: Some(CONVERSATION_PAGE_SIZE as u32),
            ..Default::default()
        })
        .await
    {
        Ok(list) => {
            let more = list.len() >= CONVERSATION_PAGE_SIZE;
            let _ = vault.save_conversations(&my_id, &list);
            {
                let mut g = state.lock().await;
                g.conversations = list.clone();
                g.conversations_has_more = more;
            }
            on_ui(weak, move |ui| {
                ui.set_has_more_chats(more);
                ui.set_syncing(false);
            });
            refresh_chat_list_ui(weak, state).await;

            // Decrypt missing/stale previews lazily for crisp UX
            if let Some(ring) = keyring {
                for conv in list.iter().take(15) {
                    if conv.last_message_at.is_none() {
                        continue;
                    }
                    if let Ok(msgs) = rpc.get_messages(&conv.id, None, 1).await {
                        if let Some(latest) = msgs.last() {
                            if vault.load_pubkeys(&conv.peer_id).ok().flatten().is_none() {
                                if let Ok(pks) = rpc.get_public_keys(&conv.peer_id).await {
                                    let _ = vault.save_pubkeys(&conv.peer_id, &pks);
                                    state
                                        .lock()
                                        .await
                                        .e2ee
                                        .cache_public_keys(&conv.peer_id, pks);
                                }
                            } else if let Some(pks) =
                                vault.load_pubkeys(&conv.peer_id).ok().flatten()
                            {
                                state
                                    .lock()
                                    .await
                                    .e2ee
                                    .cache_public_keys(&conv.peer_id, pks);
                            }
                            let mine = latest.sender_id.as_deref() == Some(my_id.as_str());
                            let raw_txt = if latest.deleted_at.is_some() {
                                "Pesan dihapus".to_string()
                            } else {
                                state
                                    .lock()
                                    .await
                                    .e2ee
                                    .decrypt_text(latest, &my_id, &conv.peer_id, &ring, None)
                                    .unwrap_or_else(|| "Pesan terenkripsi".to_string())
                            };
                            let preview = Preview {
                                text: preview_text(&raw_txt, mine),
                                mine,
                                at: latest.created_at.clone(),
                            };
                            let _ = vault.save_preview(&my_id, &conv.id, &preview);
                        }
                    }
                }
                refresh_chat_list_ui(weak, state).await;
            }
        }
        Err(_) => {
            on_ui(weak, |ui| {
                ui.set_syncing(false);
                ui.set_offline(true);
            });
        }
    }
}

async fn handle_realtime_event(
    weak: &Weak<MainWindow>,
    state: &Arc<Mutex<AppState>>,
    ev: RealtimeEvent,
) {
    match ev {
        RealtimeEvent::PresenceSync {
            conversation_id,
            online,
        } => {
            let active = state
                .lock()
                .await
                .active_conv
                .as_ref()
                .map(|c| c.id == conversation_id)
                .unwrap_or(false);
            if active {
                on_ui(weak, move |ui| ui.set_peer_online(online));
            }
        }
        RealtimeEvent::PeerTyping { conversation_id } => {
            let active = state
                .lock()
                .await
                .active_conv
                .as_ref()
                .map(|c| c.id == conversation_id)
                .unwrap_or(false);
            if active {
                on_ui(weak, |ui| ui.set_peer_typing(true));
                let w = weak.clone();
                let s = state.clone();
                let cid = conversation_id;
                tokio::spawn(async move {
                    tokio::time::sleep(seru24_core::realtime::TYPING_VISIBLE_DURATION).await;
                    let still = s
                        .lock()
                        .await
                        .active_conv
                        .as_ref()
                        .map(|c| c.id == cid)
                        .unwrap_or(false);
                    if still {
                        on_ui(&w, |ui| ui.set_peer_typing(false));
                    }
                });
            }
        }
        RealtimeEvent::CallSignal {
            conversation_id,
            signal,
        } => {
            extra_ctrl::handle_incoming_call_signal(weak, state, &conversation_id, signal).await;
        }
        RealtimeEvent::Inbox { kind, payload } => {
            let Some(cid) = payload
                .get("conversation_id")
                .and_then(|v| v.as_str())
                .map(str::to_string)
            else {
                return;
            };
            match kind {
                InboxEventKind::Read => {
                    let seq = payload.get("seq").and_then(|v| v.as_i64()).unwrap_or(0);
                    let mut refresh = false;
                    {
                        let mut g = state.lock().await;
                        if g.active_conv.as_ref().map(|c| c.id == cid).unwrap_or(false)
                            && seq > g.peer_read_seq
                        {
                            g.peer_read_seq = seq;
                            refresh = true;
                        }
                    }
                    if refresh {
                        chat_ctrl::sync_bubbles_to_ui(weak, state).await;
                    }
                }
                InboxEventKind::MessageNew | InboxEventKind::MessageUpdate => {
                    if let Ok(msg) = serde_json::from_value::<ChatMessage>(payload) {
                        let (is_active, my_id, notify) = {
                            let g = state.lock().await;
                            (
                                g.active_conv.as_ref().map(|c| c.id == cid).unwrap_or(false),
                                g.client
                                    .me
                                    .as_ref()
                                    .map(|m| m.id.clone())
                                    .unwrap_or_default(),
                                g.notify_enabled,
                            )
                        };
                        if kind == InboxEventKind::MessageNew
                            && notify
                            && msg.sender_id.as_deref() != Some(my_id.as_str())
                            && !is_active
                        {
                            platform::show_notification("seru24", "Pesan baru", &cid);
                        }
                        if is_active {
                            chat_ctrl::apply_incoming_message(weak, state, msg).await;
                            if kind == InboxEventKind::MessageNew {
                                on_ui(weak, |ui| ui.set_peer_typing(false));
                            }
                        } else {
                            load_conversations_and_previews(weak, state).await;
                        }
                    }
                }
            }
        }
        RealtimeEvent::Disconnected => {}
    }
}
