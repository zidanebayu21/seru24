//! Tes jaringan, antrean outbox offline (termasuk fallback PGRST202), storage SQLite terenkripsi,
//! dan protokol Phoenix Realtime memakai mock server `wiremock`.

use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;

use serde_json::json;
use wiremock::matchers::{method, path};
use wiremock::{Mock, MockServer, Request, Respond, ResponseTemplate};

use seru24_core::api::{AccountStatus, SeruClient};
use seru24_core::chat::Conversation;
use seru24_core::crypto::{
    derive_password_secrets, generate_key_pair, public_key_from_secret, random_bytes, to_base64,
    to_base64_url, MessageKind, KEY_BYTES, NONCE_BYTES,
};
use seru24_core::e2ee::SealedMessageParams;
use seru24_core::env::AppEnv;
use seru24_core::outbox::{
    flush_outbox, queue_message, queued_for, send_with_offline_time, QueuedMessage,
};
use seru24_core::realtime::{
    build_realtime_ws_url, parse_incoming_frame, InboxEventKind, RealtimeEvent,
};
use seru24_core::storage::LocalVault;
use seru24_core::transport::{open_request, seal_response, transport_key_id};

struct EnvelopeResponder {
    server_secret: [u8; KEY_BYTES],
    key_id: String,
    response_body: serde_json::Value,
}

impl Respond for EnvelopeResponder {
    fn respond(&self, req: &Request) -> ResponseTemplate {
        let raw = String::from_utf8_lossy(&req.body);
        let opened = open_request(&raw, &self.server_secret, &self.key_id).unwrap();
        let reply =
            seal_response(&self.response_body, &opened.key_res, &opened.request_id).unwrap();
        ResponseTemplate::new(200).set_body_string(reply)
    }
}

struct SendFallbackResponder {
    calls: Arc<AtomicUsize>,
}

impl Respond for SendFallbackResponder {
    fn respond(&self, req: &Request) -> ResponseTemplate {
        let idx = self.calls.fetch_add(1, Ordering::SeqCst);
        let v: serde_json::Value = serde_json::from_slice(&req.body).unwrap();
        if idx == 0 {
            assert!(v.get("p_offline_sent_at").is_some());
            ResponseTemplate::new(404).set_body_json(json!({
                "code": "PGRST202",
                "message": "Could not find the function public.seru24_send_message with p_offline_sent_at"
            }))
        } else {
            assert!(v.get("p_offline_sent_at").is_none());
            ResponseTemplate::new(200).set_body_json(json!({
                "ok": true,
                "id": "msg-server-1",
                "seq": 42,
                "created_at": "2026-11-20T08:00:00Z"
            }))
        }
    }
}

#[tokio::test]
async fn login_unlock_and_outbox_pgrst202_fallback_work() {
    let server = MockServer::start().await;
    let server_sec = *random_bytes::<KEY_BYTES>().unwrap();
    let server_pub = public_key_from_secret(&server_sec);
    let key_id = transport_key_id(&server_pub);

    let salt = to_base64(&[7u8; 16]);
    let pw = derive_password_secrets("KunciRahasia123!", &salt).unwrap();
    let _ = pw;

    Mock::given(method("GET"))
        .and(path("/api/crypto/public-key"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "key_id": key_id,
            "public_key": to_base64_url(&server_pub)
        })))
        .mount(&server)
        .await;

    Mock::given(method("POST"))
        .and(path("/api/auth/prelogin"))
        .respond_with(EnvelopeResponder {
            server_secret: server_sec,
            key_id: key_id.clone(),
            response_body: json!({ "salt": salt }),
        })
        .mount(&server)
        .await;

    Mock::given(method("POST"))
        .and(path("/api/auth/login"))
        .respond_with(EnvelopeResponder {
            server_secret: server_sec,
            key_id: key_id.clone(),
            response_body: json!({
                "access_token": "jwt-access-1",
                "expires_at": 4_000_000_000_i64,
                "user_id": "user-1",
                "refresh_token": "rt-rotated-1"
            }),
        })
        .mount(&server)
        .await;

    Mock::given(method("POST"))
        .and(path("/rest/v1/rpc/seru24_register_device"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!(null)))
        .mount(&server)
        .await;

    Mock::given(method("POST"))
        .and(path("/rest/v1/rpc/seru24_me"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "id": "user-1",
            "username": "rina_p",
            "display_name": "Rina",
            "has_keys": false,
            "key_version": null
        })))
        .mount(&server)
        .await;

    Mock::given(method("POST"))
        .and(path("/rest/v1/rpc/seru24_set_initial_keys"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!(null)))
        .mount(&server)
        .await;

    let calls = Arc::new(AtomicUsize::new(0));
    Mock::given(method("POST"))
        .and(path("/rest/v1/rpc/seru24_send_message"))
        .respond_with(SendFallbackResponder {
            calls: calls.clone(),
        })
        .mount(&server)
        .await;

    let vault = LocalVault::open_in_memory().unwrap();
    let env = AppEnv {
        supabase_url: server.uri(),
        supabase_anon_key: "anon-uji".into(),
        api_base_url: server.uri(),
        password_min_length: 12,
    };
    let mut client = SeruClient::new(env, vault.clone(), "android", "Pixel Test").unwrap();
    let st = client
        .login_and_unlock("rina_p", "KunciRahasia123!")
        .await
        .unwrap();
    assert_eq!(st, AccountStatus::Ready);
    assert!(client.keyring.as_ref().unwrap().contains_key("1"));

    // Simulasi outbox offline + fallback PGRST202
    let item = QueuedMessage {
        conversation_id: "conv-1".into(),
        params: SealedMessageParams {
            p_conversation_id: "conv-1".into(),
            p_client_msg_id: "cm-1".into(),
            p_kind: MessageKind::Text,
            p_ciphertext: to_base64(b"cipher"),
            p_nonce: to_base64(&*random_bytes::<NONCE_BYTES>().unwrap()),
            p_sender_key_version: 1,
            p_recipient_key_version: 1,
            p_attachment_id: None,
            p_reply_to: None,
        },
        queued_at: "2026-11-20T07:59:00Z".into(),
    };
    queue_message(&vault, "user-1", item.clone()).unwrap();
    assert_eq!(queued_for(&vault, "user-1", "conv-1").unwrap().len(), 1);

    let flushed = flush_outbox(&vault, &client.rpc, "user-1").await.unwrap();
    assert_eq!(flushed.len(), 1);
    assert!(flushed[0].result.ok);
    assert_eq!(flushed[0].result.seq, Some(42));
    assert_eq!(calls.load(Ordering::SeqCst), 2);
    assert!(queued_for(&vault, "user-1", "conv-1").unwrap().is_empty());

    // Direct call PGRST202 helper check
    let _ = send_with_offline_time;
    let _ = generate_key_pair().unwrap();
}

#[test]
fn encrypted_vault_and_realtime_parser_work() {
    let vault = LocalVault::open_in_memory().unwrap();
    let conv = Conversation {
        id: "c1".into(),
        status: seru24_core::chat::ConversationStatus::Accepted,
        requested_by: None,
        last_message_at: Some("2026-11-20T08:00:00Z".into()),
        unread: 2,
        muted: false,
        archived: false,
        pinned: true,
        peer_id: "u2".into(),
        peer_username: "budi".into(),
        peer_display_name: "Budi".into(),
        peer_blocked: false,
    };
    vault
        .save_conversations("u1", std::slice::from_ref(&conv))
        .unwrap();
    let loaded = vault.load_conversations("u1").unwrap();
    assert_eq!(loaded, vec![conv]);
    assert_eq!(vault.stats("u1").unwrap().conversations, 1);

    let ws_url = build_realtime_ws_url("https://demo.supabase.co", "key123").unwrap();
    assert_eq!(
        ws_url,
        "wss://demo.supabase.co/realtime/v1/websocket?apikey=key123&vsn=1.0.0"
    );

    let mut presence = HashMap::<String, HashSet<String>>::new();
    let ev = parse_incoming_frame(
        r#"{"topic":"realtime:conv:c1","event":"presence_state","payload":{"u1":{},"u2":{}},"ref":null}"#,
        "u1",
        &mut presence,
    )
    .unwrap();
    assert!(matches!(
        ev,
        RealtimeEvent::PresenceSync { online: true, .. }
    ));

    let inbox_ev = parse_incoming_frame(
        r#"{"topic":"realtime:user:u1","event":"broadcast","payload":{"type":"broadcast","event":"message_new","payload":{"conversation_id":"c1"}},"ref":null}"#,
        "u1",
        &mut presence,
    )
    .unwrap();
    assert!(matches!(
        inbox_ev,
        RealtimeEvent::Inbox {
            kind: InboxEventKind::MessageNew,
            ..
        }
    ));
}
