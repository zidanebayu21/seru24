//! Klien Supabase Realtime protokol Phoenix WebSocket (`vsn=1.0.0`) untuk inbox (`user:<id>`)
//! dan presence/typing/sinyal panggilan (`conv:<id>`, `web/shared/inbox-core.ts`, `presence-core.ts`).

use std::collections::{HashMap, HashSet};
use std::time::{Duration, Instant};

use futures_util::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tokio::sync::mpsc;
use tokio_tungstenite::connect_async;
use tokio_tungstenite::tungstenite::Message;
use url::Url;

use crate::call_core::{CallSignal, CALL_EVENT};
use crate::chat::now_iso_utc;

pub const HEARTBEAT_INTERVAL: Duration = Duration::from_secs(25);
pub const TYPING_SEND_INTERVAL: Duration = Duration::from_secs(3);
pub const TYPING_VISIBLE_DURATION: Duration = Duration::from_secs(5);

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum InboxEventKind {
    MessageNew,
    MessageUpdate,
    Read,
}

#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct PeerPresence {
    pub online: bool,
    pub typing: bool,
}

#[derive(Debug, Clone)]
pub enum RealtimeEvent {
    Inbox {
        kind: InboxEventKind,
        payload: Value,
    },
    PresenceSync {
        conversation_id: String,
        online: bool,
    },
    PeerTyping {
        conversation_id: String,
    },
    CallSignal {
        conversation_id: String,
        signal: CallSignal,
    },
    Disconnected,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PhoenixFrame {
    pub topic: String,
    pub event: String,
    pub payload: Value,
    pub r#ref: Option<String>,
}

pub fn build_realtime_ws_url(
    supabase_url: &str,
    anon_key: &str,
) -> Result<String, url::ParseError> {
    let mut u = Url::parse(supabase_url.trim_end_matches('/'))?;
    let scheme = if u.scheme() == "http" { "ws" } else { "wss" };
    let _ = u.set_scheme(scheme);
    u.set_path("/realtime/v1/websocket");
    u.query_pairs_mut()
        .clear()
        .append_pair("apikey", anon_key)
        .append_pair("vsn", "1.0.0");
    Ok(u.to_string())
}

pub fn join_user_inbox_frame(user_id: &str, access_token: &str, ref_id: &str) -> PhoenixFrame {
    PhoenixFrame {
        topic: format!("realtime:user:{user_id}"),
        event: "phx_join".to_string(),
        payload: json!({
            "config": {
                "broadcast": { "ack": false, "self": false },
                "presence": { "enabled": false, "key": "" },
                "postgres_changes": [],
                "private": true
            },
            "access_token": access_token
        }),
        r#ref: Some(ref_id.to_string()),
    }
}

pub fn join_conv_presence_frame(
    conversation_id: &str,
    my_id: &str,
    access_token: &str,
    ref_id: &str,
) -> PhoenixFrame {
    PhoenixFrame {
        topic: format!("realtime:conv:{conversation_id}"),
        event: "phx_join".to_string(),
        payload: json!({
            "config": {
                "broadcast": { "ack": false, "self": false },
                "presence": { "enabled": true, "key": my_id },
                "postgres_changes": [],
                "private": true
            },
            "access_token": access_token
        }),
        r#ref: Some(ref_id.to_string()),
    }
}

pub fn heartbeat_frame(ref_id: &str) -> PhoenixFrame {
    PhoenixFrame {
        topic: "phoenix".to_string(),
        event: "heartbeat".to_string(),
        payload: json!({}),
        r#ref: Some(ref_id.to_string()),
    }
}

pub fn presence_track_frame(conversation_id: &str, ref_id: &str) -> PhoenixFrame {
    PhoenixFrame {
        topic: format!("realtime:conv:{conversation_id}"),
        event: "presence".to_string(),
        payload: json!({
            "type": "presence",
            "event": "track",
            "payload": { "at": now_iso_utc() }
        }),
        r#ref: Some(ref_id.to_string()),
    }
}

pub fn broadcast_typing_frame(conversation_id: &str, my_id: &str, ref_id: &str) -> PhoenixFrame {
    PhoenixFrame {
        topic: format!("realtime:conv:{conversation_id}"),
        event: "broadcast".to_string(),
        payload: json!({
            "type": "broadcast",
            "event": "typing",
            "payload": { "user_id": my_id }
        }),
        r#ref: Some(ref_id.to_string()),
    }
}

pub fn broadcast_call_frame(
    conversation_id: &str,
    signal: &CallSignal,
    ref_id: &str,
) -> PhoenixFrame {
    PhoenixFrame {
        topic: format!("realtime:conv:{conversation_id}"),
        event: "broadcast".to_string(),
        payload: json!({
            "type": "broadcast",
            "event": CALL_EVENT,
            "payload": signal
        }),
        r#ref: Some(ref_id.to_string()),
    }
}

pub fn parse_incoming_frame(
    raw: &str,
    my_id: &str,
    presence_keys: &mut HashMap<String, HashSet<String>>,
) -> Option<RealtimeEvent> {
    let frame: PhoenixFrame = serde_json::from_str(raw).ok()?;
    let topic = frame
        .topic
        .strip_prefix("realtime:")
        .unwrap_or(&frame.topic);

    if let Some(conv_id) = topic.strip_prefix("conv:") {
        match frame.event.as_str() {
            "presence_state" => {
                let set = presence_keys.entry(conv_id.to_string()).or_default();
                set.clear();
                if let Some(obj) = frame.payload.as_object() {
                    for k in obj.keys() {
                        set.insert(k.clone());
                    }
                }
                let online = set.iter().any(|k| k != my_id);
                return Some(RealtimeEvent::PresenceSync {
                    conversation_id: conv_id.to_string(),
                    online,
                });
            }
            "presence_diff" => {
                let set = presence_keys.entry(conv_id.to_string()).or_default();
                if let Some(joins) = frame.payload.get("joins").and_then(|v| v.as_object()) {
                    for k in joins.keys() {
                        set.insert(k.clone());
                    }
                }
                if let Some(leaves) = frame.payload.get("leaves").and_then(|v| v.as_object()) {
                    for k in leaves.keys() {
                        set.remove(k);
                    }
                }
                let online = set.iter().any(|k| k != my_id);
                return Some(RealtimeEvent::PresenceSync {
                    conversation_id: conv_id.to_string(),
                    online,
                });
            }
            "broadcast" => {
                let ev = frame.payload.get("event").and_then(|v| v.as_str())?;
                let inner = frame.payload.get("payload")?.clone();
                if ev == "typing" {
                    let sender = inner.get("user_id").and_then(|v| v.as_str());
                    if sender == Some(my_id) {
                        return None;
                    }
                    return Some(RealtimeEvent::PeerTyping {
                        conversation_id: conv_id.to_string(),
                    });
                }
                if ev == CALL_EVENT {
                    if let Ok(signal) = serde_json::from_value::<CallSignal>(inner) {
                        return Some(RealtimeEvent::CallSignal {
                            conversation_id: conv_id.to_string(),
                            signal,
                        });
                    }
                }
            }
            _ => {}
        }
        return None;
    }

    if topic.starts_with("user:") && frame.event == "broadcast" {
        let ev = frame.payload.get("event").and_then(|v| v.as_str())?;
        let inner = frame.payload.get("payload")?.clone();
        let kind = match ev {
            "message_new" => InboxEventKind::MessageNew,
            "message_update" => InboxEventKind::MessageUpdate,
            "read" => InboxEventKind::Read,
            _ => return None,
        };
        return Some(RealtimeEvent::Inbox {
            kind,
            payload: inner,
        });
    }

    None
}

enum RealtimeCmd {
    OpenConv {
        conversation_id: String,
    },
    CloseConv {
        conversation_id: String,
    },
    NotifyTyping {
        conversation_id: String,
    },
    SendCallSignal {
        conversation_id: String,
        signal: CallSignal,
    },
    UpdateToken {
        access_token: String,
    },
    Shutdown,
}

/// Klien WebSocket Realtime latar belakang yang mengelola heartbeat, reconnect, dan saluran privat.
pub struct RealtimeHandle {
    cmd_tx: mpsc::UnboundedSender<RealtimeCmd>,
}

impl RealtimeHandle {
    pub fn connect(
        supabase_url: String,
        anon_key: String,
        user_id: String,
        initial_token: String,
    ) -> (Self, mpsc::UnboundedReceiver<RealtimeEvent>) {
        let (cmd_tx, mut cmd_rx) = mpsc::unbounded_channel::<RealtimeCmd>();
        let (ev_tx, ev_rx) = mpsc::unbounded_channel::<RealtimeEvent>();

        tokio::spawn(async move {
            let mut token = initial_token;
            let mut active_convs: HashSet<String> = HashSet::new();
            let mut last_typing: HashMap<String, Instant> = HashMap::new();
            let mut backoff = Duration::from_secs(1);

            while let Ok(ws_url) = build_realtime_ws_url(&supabase_url, &anon_key) {
                match connect_async(&ws_url).await {
                    Ok((ws_stream, _)) => {
                        backoff = Duration::from_secs(1);
                        let (mut write, mut read) = ws_stream.split();
                        let mut ref_counter: u64 = 1;
                        let mut next_ref = || {
                            let r = ref_counter.to_string();
                            ref_counter += 1;
                            r
                        };

                        let join = join_user_inbox_frame(&user_id, &token, &next_ref());
                        if let Ok(txt) = serde_json::to_string(&join) {
                            let _ = write.send(Message::Text(txt.into())).await;
                        }
                        for conv_id in &active_convs {
                            let frame =
                                join_conv_presence_frame(conv_id, &user_id, &token, &next_ref());
                            if let Ok(txt) = serde_json::to_string(&frame) {
                                let _ = write.send(Message::Text(txt.into())).await;
                            }
                            let track = presence_track_frame(conv_id, &next_ref());
                            if let Ok(txt) = serde_json::to_string(&track) {
                                let _ = write.send(Message::Text(txt.into())).await;
                            }
                        }

                        let mut presence_keys: HashMap<String, HashSet<String>> = HashMap::new();
                        let mut hb = tokio::time::interval(HEARTBEAT_INTERVAL);
                        hb.tick().await;

                        let should_stop = loop {
                            tokio::select! {
                                _ = hb.tick() => {
                                    let frame = heartbeat_frame(&next_ref());
                                    if let Ok(txt) = serde_json::to_string(&frame) {
                                        if write.send(Message::Text(txt.into())).await.is_err() {
                                            break false;
                                        }
                                    }
                                }
                                Some(cmd) = cmd_rx.recv() => {
                                    match cmd {
                                        RealtimeCmd::Shutdown => break true,
                                        RealtimeCmd::UpdateToken { access_token } => {
                                            token = access_token;
                                            let mut topics = vec![format!("realtime:user:{user_id}")];
                                            for c in &active_convs {
                                                topics.push(format!("realtime:conv:{c}"));
                                            }
                                            for t in topics {
                                                let f = PhoenixFrame {
                                                    topic: t,
                                                    event: "access_token".to_string(),
                                                    payload: json!({ "access_token": token }),
                                                    r#ref: Some(next_ref()),
                                                };
                                                if let Ok(txt) = serde_json::to_string(&f) {
                                                    let _ = write.send(Message::Text(txt.into())).await;
                                                }
                                            }
                                        }
                                        RealtimeCmd::OpenConv { conversation_id } => {
                                            if active_convs.insert(conversation_id.clone()) {
                                                let f = join_conv_presence_frame(&conversation_id, &user_id, &token, &next_ref());
                                                if let Ok(txt) = serde_json::to_string(&f) {
                                                    let _ = write.send(Message::Text(txt.into())).await;
                                                }
                                                let t = presence_track_frame(&conversation_id, &next_ref());
                                                if let Ok(txt) = serde_json::to_string(&t) {
                                                    let _ = write.send(Message::Text(txt.into())).await;
                                                }
                                            }
                                        }
                                        RealtimeCmd::CloseConv { conversation_id } => {
                                            active_convs.remove(&conversation_id);
                                            presence_keys.remove(&conversation_id);
                                            let f = PhoenixFrame {
                                                topic: format!("realtime:conv:{conversation_id}"),
                                                event: "phx_leave".to_string(),
                                                payload: json!({}),
                                                r#ref: Some(next_ref()),
                                            };
                                            if let Ok(txt) = serde_json::to_string(&f) {
                                                let _ = write.send(Message::Text(txt.into())).await;
                                            }
                                        }
                                        RealtimeCmd::NotifyTyping { conversation_id } => {
                                            let now = Instant::now();
                                            let allow = last_typing
                                                .get(&conversation_id)
                                                .map(|prev| now.duration_since(*prev) >= TYPING_SEND_INTERVAL)
                                                .unwrap_or(true);
                                            if allow {
                                                last_typing.insert(conversation_id.clone(), now);
                                                let f = broadcast_typing_frame(&conversation_id, &user_id, &next_ref());
                                                if let Ok(txt) = serde_json::to_string(&f) {
                                                    let _ = write.send(Message::Text(txt.into())).await;
                                                }
                                            }
                                        }
                                        RealtimeCmd::SendCallSignal { conversation_id, signal } => {
                                            let f = broadcast_call_frame(&conversation_id, &signal, &next_ref());
                                            if let Ok(txt) = serde_json::to_string(&f) {
                                                let _ = write.send(Message::Text(txt.into())).await;
                                            }
                                        }
                                    }
                                }
                                msg = read.next() => {
                                    match msg {
                                        Some(Ok(Message::Text(txt))) => {
                                            if let Some(ev) = parse_incoming_frame(&txt, &user_id, &mut presence_keys) {
                                                let _ = ev_tx.send(ev);
                                            }
                                        }
                                        Some(Ok(_)) => {}
                                        Some(Err(_)) | None => break false,
                                    }
                                }
                            }
                        };
                        let _ = ev_tx.send(RealtimeEvent::Disconnected);
                        if should_stop {
                            break;
                        }
                    }
                    Err(_) => {
                        let _ = ev_tx.send(RealtimeEvent::Disconnected);
                    }
                }

                tokio::select! {
                    _ = tokio::time::sleep(backoff) => {}
                    cmd = cmd_rx.recv() => {
                        match cmd {
                            Some(RealtimeCmd::Shutdown) | None => break,
                            Some(RealtimeCmd::OpenConv { conversation_id }) => {
                                active_convs.insert(conversation_id);
                            }
                            Some(RealtimeCmd::CloseConv { conversation_id }) => {
                                active_convs.remove(&conversation_id);
                            }
                            Some(RealtimeCmd::UpdateToken { access_token }) => {
                                token = access_token;
                            }
                            _ => {}
                        }
                    }
                }
                backoff = (backoff * 2).min(Duration::from_secs(30));
            }
        });

        (Self { cmd_tx }, ev_rx)
    }

    pub fn open_conversation(&self, conversation_id: impl Into<String>) {
        let _ = self.cmd_tx.send(RealtimeCmd::OpenConv {
            conversation_id: conversation_id.into(),
        });
    }

    pub fn close_conversation(&self, conversation_id: impl Into<String>) {
        let _ = self.cmd_tx.send(RealtimeCmd::CloseConv {
            conversation_id: conversation_id.into(),
        });
    }

    pub fn notify_typing(&self, conversation_id: impl Into<String>) {
        let _ = self.cmd_tx.send(RealtimeCmd::NotifyTyping {
            conversation_id: conversation_id.into(),
        });
    }

    pub fn send_call_signal(&self, conversation_id: impl Into<String>, signal: CallSignal) {
        let _ = self.cmd_tx.send(RealtimeCmd::SendCallSignal {
            conversation_id: conversation_id.into(),
            signal,
        });
    }

    pub fn update_access_token(&self, access_token: impl Into<String>) {
        let _ = self.cmd_tx.send(RealtimeCmd::UpdateToken {
            access_token: access_token.into(),
        });
    }

    pub fn shutdown(&self) {
        let _ = self.cmd_tx.send(RealtimeCmd::Shutdown);
    }
}
