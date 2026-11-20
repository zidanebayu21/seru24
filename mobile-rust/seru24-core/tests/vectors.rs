//! Uji vektor silang dua arah TypeScript <-> Rust (Fase 1, Gerbang 1).

use std::collections::BTreeMap;
use std::io::Write;
use std::process::{Command, Stdio};

use serde::{Deserialize, Serialize};
use serde_json::json;
use zeroize::Zeroizing;

use seru24_core::backup::{open_backup, seal_backup, BackupData};
use seru24_core::crypto::{
    as_key_array, create_key_backup, decrypt_message, derive_conversation_key,
    derive_password_secrets, encrypt_message, from_base64, open_key_backup, public_key_from_secret,
    safety_code, to_base64, EncryptedPayload, KeyBackup, MessageContext, MessageKind, PartyKey,
    SecretKeyring,
};
use seru24_core::nearby::{build_endpoint_name, contact_tag, EndpointName};
use seru24_core::transport::{open_response, seal_request, transport_key_id};

#[derive(Deserialize)]
struct MsgCtxRaw {
    #[serde(rename = "conversationId")]
    conversation_id: String,
    #[serde(rename = "senderId")]
    sender_id: String,
    #[serde(rename = "clientMsgId")]
    client_msg_id: String,
    kind: MessageKind,
}

#[derive(Deserialize)]
struct FileExpected {
    id: String,
    name: String,
    mime: String,
    size: u64,
    key: String,
    iv: String,
}

#[derive(Deserialize)]
struct Vectors {
    alice_secret_b64: String,
    alice_public_b64: String,
    bob_secret_b64: String,
    bob_public_b64: String,
    conversation_id: String,
    alice_id: String,
    bob_id: String,
    conversation_key_b64: String,
    safety_code: String,
    password_raw: String,
    auth_salt_b64: String,
    auth_secret: String,
    wrap_key_b64: String,
    text_msg_ctx: MsgCtxRaw,
    encrypted_text: EncryptedPayload,
    text_expected: String,
    file_msg_ctx: MsgCtxRaw,
    encrypted_file: EncryptedPayload,
    file_expected: FileExpected,
    key_backup: KeyBackup,
    chat_backup_text: String,
    server_secret_b64: String,
    server_public_b64: String,
    transport_key_id: String,
    server_res_key_b64: String,
    sample_response_compact: String,
    sample_response_req_id: String,
    nearby_contact_tag: String,
    nearby_endpoint_name: String,
}

#[derive(Deserialize)]
struct DecryptedText {
    t: String,
}

#[derive(Deserialize)]
struct DecryptedFile {
    f: FileExpected,
}

#[derive(Deserialize)]
struct PingResp {
    ok: bool,
    ping: String,
}

#[derive(Deserialize)]
struct NodeVerifyOut {
    ok: bool,
    server_reply_compact: String,
    request_id: String,
}

#[derive(Serialize)]
struct TextOut<'a> {
    t: &'a str,
}

#[test]
fn cross_vectors_ts_to_rust_and_rust_to_ts() {
    let raw = include_str!("vectors.json");
    let v: Vectors = serde_json::from_str(raw).expect("vectors.json valid");

    let alice_sec = as_key_array(&from_base64(&v.alice_secret_b64).unwrap()).unwrap();
    let bob_sec = as_key_array(&from_base64(&v.bob_secret_b64).unwrap()).unwrap();
    let alice_pub = as_key_array(&from_base64(&v.alice_public_b64).unwrap()).unwrap();
    let bob_pub = as_key_array(&from_base64(&v.bob_public_b64).unwrap()).unwrap();
    let server_pub = as_key_array(&from_base64(&v.server_public_b64).unwrap()).unwrap();

    assert_eq!(
        to_base64(&public_key_from_secret(&alice_sec)),
        v.alice_public_b64
    );
    assert_eq!(
        to_base64(&public_key_from_secret(&bob_sec)),
        v.bob_public_b64
    );

    // 1. derive_conversation_key identik di kedua sisi
    let ck_a = derive_conversation_key(
        &alice_sec,
        &bob_pub,
        &v.conversation_id,
        PartyKey {
            user_id: &v.alice_id,
            key_version: 1,
        },
        PartyKey {
            user_id: &v.bob_id,
            key_version: 2,
        },
    )
    .unwrap();
    let ck_b = derive_conversation_key(
        &bob_sec,
        &alice_pub,
        &v.conversation_id,
        PartyKey {
            user_id: &v.bob_id,
            key_version: 2,
        },
        PartyKey {
            user_id: &v.alice_id,
            key_version: 1,
        },
    )
    .unwrap();
    assert_eq!(to_base64(&*ck_a), v.conversation_key_b64);
    assert_eq!(to_base64(&*ck_b), v.conversation_key_b64);

    // 2. safety_code identik (tidak peduli urutan argumen)
    assert_eq!(safety_code(&alice_pub, &bob_pub), v.safety_code);
    assert_eq!(safety_code(&bob_pub, &alice_pub), v.safety_code);

    // 3. scrypt NFKC + HKDF identik
    let pw = derive_password_secrets(&v.password_raw, &v.auth_salt_b64).unwrap();
    assert_eq!(pw.auth_secret.as_str(), v.auth_secret);
    assert_eq!(to_base64(&*pw.wrap_key), v.wrap_key_b64);

    // 4. Dekripsi pesan teks & file buatan TypeScript
    let text_msg: DecryptedText = decrypt_message(
        &ck_b,
        &v.encrypted_text,
        &MessageContext {
            conversation_id: &v.text_msg_ctx.conversation_id,
            sender_id: &v.text_msg_ctx.sender_id,
            client_msg_id: &v.text_msg_ctx.client_msg_id,
            kind: v.text_msg_ctx.kind,
        },
    )
    .unwrap();
    assert_eq!(text_msg.t, v.text_expected);

    let file_msg: DecryptedFile = decrypt_message(
        &ck_a,
        &v.encrypted_file,
        &MessageContext {
            conversation_id: &v.file_msg_ctx.conversation_id,
            sender_id: &v.file_msg_ctx.sender_id,
            client_msg_id: &v.file_msg_ctx.client_msg_id,
            kind: v.file_msg_ctx.kind,
        },
    )
    .unwrap();
    assert_eq!(file_msg.f.id, v.file_expected.id);
    assert_eq!(file_msg.f.name, v.file_expected.name);
    assert_eq!(file_msg.f.mime, v.file_expected.mime);
    assert_eq!(file_msg.f.size, v.file_expected.size);
    assert_eq!(file_msg.f.key, v.file_expected.key);
    assert_eq!(file_msg.f.iv, v.file_expected.iv);

    // 5. Buka KeyBackup & ChatBackup buatan TypeScript
    let keyring = open_key_backup(&v.key_backup, &pw.wrap_key, &v.alice_id).unwrap();
    assert_eq!(to_base64(&**keyring.get("1").unwrap()), v.alice_secret_b64);
    assert_eq!(to_base64(&**keyring.get("2").unwrap()), v.bob_secret_b64);

    let mut backup_ring: SecretKeyring = BTreeMap::new();
    backup_ring.insert("10".to_string(), Zeroizing::new(bob_sec));
    backup_ring.insert("2".to_string(), Zeroizing::new(alice_sec));
    let chat_backup = open_backup(&backup_ring, &v.alice_id, &v.chat_backup_text).unwrap();
    assert_eq!(chat_backup.conversations.len(), 1);
    assert_eq!(chat_backup.conversations[0].id, v.conversation_id);

    // 6. Transport key_id & buka response buatan TS
    let key_id = transport_key_id(&server_pub);
    assert_eq!(key_id, v.transport_key_id);
    let res_key = as_key_array(&from_base64(&v.server_res_key_b64).unwrap()).unwrap();
    let ping: PingResp = open_response(
        &v.sample_response_compact,
        &res_key,
        &v.sample_response_req_id,
    )
    .unwrap();
    assert!(ping.ok);
    assert_eq!(ping.ping, "pong");

    // 7. Nearby contact_tag & endpoint name
    let tag = contact_tag(&v.conversation_id, &v.alice_id);
    assert_eq!(tag, v.nearby_contact_tag);
    assert_eq!(
        build_endpoint_name(&EndpointName {
            alias: "Anonim-AB12".to_string(),
            id: "deadbeef".to_string(),
            tags: vec![tag],
        }),
        v.nearby_endpoint_name
    );

    // 8. ARAH BALIK: Rust enkripsi -> Node/TypeScript dekripsi & jawab balik
    let rust_encrypted_text = encrypt_message(
        &ck_a,
        &TextOut {
            t: &v.text_expected,
        },
        &MessageContext {
            conversation_id: &v.text_msg_ctx.conversation_id,
            sender_id: &v.text_msg_ctx.sender_id,
            client_msg_id: &v.text_msg_ctx.client_msg_id,
            kind: MessageKind::Text,
        },
    )
    .unwrap();
    let rust_key_backup =
        create_key_backup(&keyring, &pw.wrap_key, &v.alice_id, &v.auth_salt_b64).unwrap();
    let rust_chat_backup = seal_backup(
        &backup_ring,
        &v.alice_id,
        &BackupData {
            exported_at: "2026-11-20T07:30:00.000Z".to_string(),
            conversations: chat_backup.conversations.clone(),
            messages: vec![],
        },
    )
    .unwrap();
    let sealed_req = seal_request(
        &server_pub,
        &key_id,
        &json!({ "identifier": "rina_uji" }),
        1_795_000_000,
    )
    .unwrap();

    let payload_for_node = serde_json::to_string(&json!({
        "alice_secret_b64": v.alice_secret_b64,
        "bob_public_b64": v.bob_public_b64,
        "server_secret_b64": v.server_secret_b64,
        "server_public_b64": v.server_public_b64,
        "conversation_id": v.conversation_id,
        "alice_id": v.alice_id,
        "bob_id": v.bob_id,
        "password_raw": v.password_raw,
        "auth_salt_b64": v.auth_salt_b64,
        "rust_auth_secret": pw.auth_secret.as_str(),
        "rust_wrap_key_b64": to_base64(&*pw.wrap_key),
        "text_msg_ctx": {
            "conversationId": v.text_msg_ctx.conversation_id,
            "senderId": v.text_msg_ctx.sender_id,
            "clientMsgId": v.text_msg_ctx.client_msg_id,
            "kind": "text",
        },
        "text_expected": v.text_expected,
        "rust_encrypted_text": rust_encrypted_text,
        "rust_key_backup": rust_key_backup,
        "rust_chat_backup": rust_chat_backup,
        "rust_transport_compact": sealed_req.compact,
    }))
    .unwrap();

    let mut child = Command::new("node")
        .args([
            "--import",
            "./tests/ts_loader.mjs",
            "tests/verify_rust_vectors.mjs",
        ])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("jalankan node tests/verify_rust_vectors.mjs");
    child
        .stdin
        .take()
        .unwrap()
        .write_all(payload_for_node.as_bytes())
        .unwrap();
    let output = child.wait_with_output().unwrap();
    assert!(
        output.status.success(),
        "Node verify_rust_vectors gagal: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    let node_out: NodeVerifyOut = serde_json::from_slice(&output.stdout).unwrap();
    assert!(node_out.ok);
    assert_eq!(node_out.request_id, sealed_req.request_id);

    #[derive(Deserialize)]
    struct EchoReply {
        status: String,
        echo: String,
    }
    let opened_reply: EchoReply = open_response(
        &node_out.server_reply_compact,
        &sealed_req.key_res,
        &sealed_req.request_id,
    )
    .unwrap();
    assert_eq!(opened_reply.status, "ok");
    assert_eq!(opened_reply.echo, "rina_uji");
}
