//! Tes perilaku domain `seru24-core` (chat ordering, search, nearby, pin, schedule, call, release).

use std::collections::HashSet;

use chrono::{Local, TimeZone};
use serde_json::json;

use seru24_core::app_release::{
    drive_links, is_newer_release, is_newer_rust_release, parse_app_release,
};
use seru24_core::call_core::{
    CallAction, CallEndReason, CallPhase, CallSignal, CallSignalType, CallStateMachine,
};
use seru24_core::call_quality::{call_quality_key, CallQuality};
use seru24_core::chat::{
    bubble_status, compare_bubbles, reply_snippet, slice_messages_page, CacheableMsg, PagedBubble,
};
use seru24_core::file::{
    base_mime, format_file_size, is_uuid, is_voice_file, parse_file_body, safe_file_name,
};
use seru24_core::nearby::{parse_endpoint_name, parse_nearby_wire, stranger_conversation_id};
use seru24_core::pin::{add_pin, can_pin, parse_pins, prune_pins, remove_pin, MAX_PINS};
use seru24_core::preview::{is_fresh_preview, preview_text, Preview};
use seru24_core::schedule::{
    parse_clock_input, schedule_error_message, validate_schedule_time, ScheduleProblem,
};
use seru24_core::search::{normalize_for_search, search_messages, SearchableMessage};

#[test]
fn chat_bubble_order_matches_offline_revision_rules() {
    let normal_old = PagedBubble {
        key: "1".into(),
        seq: 1,
        pending: false,
        created_at: Some("2026-11-20T08:00:00Z".into()),
        revised: false,
    };
    let revised_offline = PagedBubble {
        key: "2".into(),
        seq: 5,
        pending: false,
        created_at: Some("2026-11-20T08:01:00Z".into()),
        revised: true,
    };
    let normal_later = PagedBubble {
        key: "3".into(),
        seq: 2,
        pending: false,
        created_at: Some("2026-11-20T08:05:00Z".into()),
        revised: false,
    };
    let pending_now = PagedBubble {
        key: "tmp".into(),
        seq: 0,
        pending: true,
        created_at: Some("2026-11-20T07:59:00Z".into()),
        revised: false,
    };

    let mut list = [pending_now, normal_later, revised_offline, normal_old];
    list.sort_by(compare_bubbles);
    let keys: Vec<&str> = list.iter().map(|b| b.key.as_str()).collect();
    assert_eq!(keys, vec!["1", "2", "3", "tmp"]);

    let status = bubble_status(false, "", true, 2, "2026-11-20T08:05:00Z", 2);
    assert_eq!(status.ticks, "✓✓");
    assert!(status.read);
    assert_eq!(reply_snippet(None, true), "Pesan dihapus");
}

#[derive(Clone)]
struct SimpleMsg(i64, String);
impl CacheableMsg for SimpleMsg {
    fn client_msg_id(&self) -> &str {
        &self.1
    }
    fn seq(&self) -> i64 {
        self.0
    }
    fn deleted_at(&self) -> Option<&str> {
        None
    }
    fn edited_at(&self) -> Option<&str> {
        None
    }
}

#[test]
fn slice_page_and_search_diacritics_work() {
    let msgs: Vec<SimpleMsg> = (1..=60).map(|i| SimpleMsg(i, format!("id-{i}"))).collect();
    let (rows, has_older) = slice_messages_page(&msgs, Some(55), 50);
    assert!(has_older);
    assert_eq!(rows.len(), 50);
    assert_eq!(rows.first().unwrap().0, 5);
    assert_eq!(rows.last().unwrap().0, 54);

    assert_eq!(normalize_for_search("Café"), "cafe");
    let hits = search_messages(
        &[SearchableMessage {
            key: "k1".into(),
            seq: 10,
            created_at: "2026-11-20T08:00:00Z".into(),
            text: Some("Ayo minum café pagi ini!".into()),
            deleted: false,
        }],
        "cafe pagi",
        10,
    );
    assert_eq!(hits.len(), 1);
    assert_eq!(hits[0].match_text, "café");
}

#[test]
fn pin_preview_file_schedule_and_release_behave_like_ts() {
    let mut pins = parse_pins(Some(r#"["a","","a","b"]"#));
    assert_eq!(pins, vec!["a", "b"]);
    for i in 0..12 {
        pins = add_pin(&pins, &format!("x{i}"));
    }
    assert_eq!(pins.len(), MAX_PINS);
    assert!(!can_pin(&pins));
    pins = remove_pin(&pins, "a");
    let live: HashSet<String> = ["b", "x0"].into_iter().map(str::to_string).collect();
    assert_eq!(prune_pins(&pins, &live), vec!["b", "x0"]);

    assert_eq!(preview_text("  halo\ndunia ", true), "Anda: halo dunia");
    let p = Preview {
        text: "hai".into(),
        mine: false,
        at: "2026-11-20T08:00:00Z".into(),
    };
    assert!(is_fresh_preview(Some(&p), Some("2026-11-20T08:00:00Z")));

    assert!(is_uuid("11111111-2222-4333-8444-555555555555"));
    assert_eq!(safe_file_name("../dir/rahasia\u{0007}.txt"), "rahasia.txt");
    assert_eq!(base_mime("Audio/WebM; codecs=opus"), "audio/webm");
    assert!(is_voice_file("audio/mp4; codecs=mp4a"));
    assert_eq!(format_file_size(2048), "2.0 KB");
    assert!(parse_file_body(&json!({ "id": "bad" })).is_none());

    let (view, dl) = drive_links("1AbCdEfGhIjKlMnOpQrStUv");
    let rel = parse_app_release(&json!({
        "versionCode": 26,
        "versionName": "1.26.0",
        "url": view,
        "downloadUrl": dl,
        "sha256": "a".repeat(64),
        "sizeBytes": 6947291,
        "updatedAt": "2026-11-20T07:00:00Z"
    }))
    .unwrap();
    assert!(is_newer_release(Some(&rel), 25));
    assert!(!is_newer_release(Some(&rel), 26));
    assert!(!is_newer_rust_release(Some(&rel), 2));
    let rust_rel = parse_app_release(&json!({
        "versionCode": 3,
        "versionName": "0.1.3",
        "url": view,
        "downloadUrl": dl,
        "sha256": "b".repeat(64),
        "sizeBytes": 16_000_000,
        "updatedAt": "2026-11-20T09:00:00Z",
        "variant": "rust"
    }))
    .unwrap();
    assert!(is_newer_rust_release(Some(&rust_rel), 2));
    assert!(!is_newer_rust_release(Some(&rust_rel), 3));

    let now = Local.with_ymd_and_hms(2026, 11, 20, 10, 0, 0).unwrap();
    assert_eq!(
        validate_schedule_time(now + chrono::Duration::seconds(30), now),
        Some(ScheduleProblem::TooSoon)
    );
    assert!(parse_clock_input("20.30", now).is_some());
    assert_eq!(
        schedule_error_message("too_soon"),
        "Pilih waktu minimal 1 menit dari sekarang."
    );
    assert_eq!(CallQuality::Standar.next(), CallQuality::Tinggi);
    assert_eq!(call_quality_key("c1"), "seru24:call-quality:c1");
}

#[test]
fn nearby_and_call_state_machine_transitions() {
    assert!(parse_endpoint_name("s1|Anonim-ABCD|1234abcd|00112233,aabbccdd").is_some());
    assert!(parse_endpoint_name("s1|Palsu|1234abcd|").is_none());
    assert_eq!(stranger_conversation_id("b", "a"), "radar:a:b");
    assert!(parse_nearby_wire(r#"{"t":"ack","id":"msg-1"}"#).is_some());
    assert!(
        parse_nearby_wire(r#"{"t":"hello","h":{"u":"u1","n":"BAD","k":1,"pk":"x"}}"#).is_none()
    );

    let mut caller = CallStateMachine::new("u1");
    let mut callee = CallStateMachine::new("u2");

    let out = caller.start_outgoing("call-1".into(), true);
    assert_eq!(caller.phase(), CallPhase::Calling);
    let invite = match &out[0] {
        CallAction::EmitSignal(s) => s.clone(),
        _ => panic!("expected invite signal"),
    };
    let inc = callee.handle_signal(invite);
    assert_eq!(callee.phase(), CallPhase::Incoming);
    assert!(matches!(
        inc[0],
        CallAction::StartRingTimeout {
            notify_peer_on_timeout: false
        }
    ));

    let acc = callee.accept_incoming(true);
    let accept_sig = match &acc[1] {
        CallAction::EmitSignal(s) => s.clone(),
        _ => panic!("expected accept"),
    };
    let off = caller.handle_signal(accept_sig);
    assert_eq!(caller.phase(), CallPhase::Connecting);
    assert!(matches!(off[1], CallAction::CreateOffer { .. }));

    caller.on_connected();
    callee.on_connected();
    let rec = caller.announce_recording(true).unwrap();
    let rec_act = callee.handle_signal(rec);
    assert_eq!(rec_act, vec![CallAction::PeerRecording(true)]);
    assert!(callee.peer_recording());

    let end = caller.hangup();
    assert_eq!(caller.phase(), CallPhase::Idle);
    assert!(matches!(
        end[2],
        CallAction::Teardown(CallEndReason::Hangup)
    ));
    let _ = CallSignal {
        signal_type: CallSignalType::Hangup,
        call_id: "call-1".into(),
        from: "u1".into(),
        sdp: None,
        candidate: None,
        on: None,
    };
}
