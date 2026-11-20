//! CLI desktop untuk memverifikasi Gerbang 2 (`cargo run -p seru24-core --example cli`).
//! Pemakaian:
//!   cargo run -p seru24-core --example cli -- login <identifier> <password>
//!   cargo run -p seru24-core --example cli -- list
//!   cargo run -p seru24-core --example cli -- read <conversation_id>
//!   cargo run -p seru24-core --example cli -- send <conversation_id> <teks>

use std::path::PathBuf;

use seru24_core::api::{AccountStatus, SeruClient};
use seru24_core::chat::{peer_label, ListConversationsOptions};
use seru24_core::crypto::PartyKey;
use seru24_core::e2ee::{E2eeEngine, SealTarget};
use seru24_core::env::AppEnv;
use seru24_core::outbox::send_with_offline_time;
use seru24_core::storage::LocalVault;

fn vault_path() -> PathBuf {
    std::env::temp_dir()
        .join("seru24-rust-cli")
        .join("vault.sqlite")
}

#[tokio::main]
async fn main() {
    let args: Vec<String> = std::env::args().collect();
    if args.len() < 2 {
        eprintln!(
            "Pemakaian:\n  cli login <identifier> <password>\n  cli list\n  cli read <conversation_id>\n  cli send <conversation_id> <teks>"
        );
        std::process::exit(2);
    }

    let env = AppEnv::from_build();
    if !env.is_configured() {
        eprintln!("Konfigurasi SUPABASE_URL / SUPABASE_ANON_KEY belum tersedia.");
        std::process::exit(1);
    }
    let vault = LocalVault::open_desktop(&vault_path()).expect("gagal membuka vault CLI");
    let mut client = SeruClient::new(env, vault, "android", "seru24-cli").expect("client");
    client.load_cached_me();

    match args[1].as_str() {
        "login" => {
            if args.len() < 4 {
                eprintln!("Butuh: cli login <identifier> <password>");
                std::process::exit(2);
            }
            match client.login_and_unlock(&args[2], &args[3]).await {
                Ok(AccountStatus::Ready) => {
                    let me = client.me.as_ref().unwrap();
                    println!(
                        "Login OK: @{} ({}) [keys={}]",
                        me.username, me.id, me.has_keys
                    );
                }
                Ok(st) => eprintln!("Login selesai dengan status: {st:?}"),
                Err(e) => {
                    eprintln!(
                        "Gagal login: {} [detail: {e}]",
                        e.user_message("Login gagal.")
                    );
                    std::process::exit(1);
                }
            }
        }
        "list" => {
            if client.restore_session().await != AccountStatus::Ready {
                eprintln!("Belum login. Jalankan `cli login` terlebih dahulu.");
                std::process::exit(1);
            }
            let convs = client
                .rpc
                .list_conversations(&ListConversationsOptions {
                    limit: Some(50),
                    ..Default::default()
                })
                .await
                .expect("gagal mengambil percakapan");
            println!("Percakapan ({}):", convs.len());
            for c in convs {
                println!(
                    "  {} | {} (@{}) | unread={} | last={}",
                    c.id,
                    peer_label(&c.peer_display_name, &c.peer_username),
                    c.peer_username,
                    c.unread,
                    c.last_message_at.as_deref().unwrap_or("-")
                );
            }
        }
        "read" => {
            if args.len() < 3 {
                eprintln!("Butuh: cli read <conversation_id>");
                std::process::exit(2);
            }
            if client.restore_session().await != AccountStatus::Ready {
                eprintln!("Belum login.");
                std::process::exit(1);
            }
            let conv_id = &args[2];
            let me = client.me.clone().unwrap();
            let keyring = client.keyring.clone().unwrap();
            let convs = client
                .rpc
                .list_conversations(&ListConversationsOptions {
                    id: Some(conv_id.clone()),
                    ..Default::default()
                })
                .await
                .expect("list conv");
            let conv = convs
                .into_iter()
                .next()
                .expect("percakapan tidak ditemukan");
            let keys = client
                .rpc
                .get_public_keys(&conv.peer_id)
                .await
                .expect("pubkeys");
            let mut e2ee = E2eeEngine::new();
            e2ee.cache_public_keys(&conv.peer_id, keys);
            let msgs = client
                .rpc
                .get_messages(conv_id, None, 20)
                .await
                .expect("messages");
            for m in msgs {
                let text = e2ee
                    .decrypt_text(&m, &me.id, &conv.peer_id, &keyring, None)
                    .unwrap_or_else(|| "<terhapus/gagal buka>".to_string());
                let who = if m.sender_id.as_deref() == Some(me.id.as_str()) {
                    "Saya"
                } else {
                    &conv.peer_username
                };
                println!("[seq={} {}] {}: {}", m.seq, m.created_at, who, text);
            }
        }
        "send" => {
            if args.len() < 4 {
                eprintln!("Butuh: cli send <conversation_id> <teks>");
                std::process::exit(2);
            }
            if client.restore_session().await != AccountStatus::Ready {
                eprintln!("Belum login.");
                std::process::exit(1);
            }
            let conv_id = &args[2];
            let text = args[3..].join(" ");
            let me = client.me.clone().unwrap();
            let keyring = client.keyring.clone().unwrap();
            let my_ver = me.key_version.expect("key_version");
            let convs = client
                .rpc
                .list_conversations(&ListConversationsOptions {
                    id: Some(conv_id.clone()),
                    ..Default::default()
                })
                .await
                .expect("list conv");
            let conv = convs
                .into_iter()
                .next()
                .expect("percakapan tidak ditemukan");
            let keys = client
                .rpc
                .get_public_keys(&conv.peer_id)
                .await
                .expect("pubkeys");
            let mut e2ee = E2eeEngine::new();
            e2ee.cache_public_keys(&conv.peer_id, keys);
            let peer_key = e2ee
                .latest_active_key(&conv.peer_id)
                .expect("kunci lawan")
                .clone();
            let sealed = e2ee
                .seal_text(
                    SealTarget {
                        conversation_id: conv_id,
                        me: PartyKey {
                            user_id: &me.id,
                            key_version: my_ver,
                        },
                        peer_id: &conv.peer_id,
                        peer_key: &peer_key,
                    },
                    &keyring,
                    &text,
                    None,
                    None,
                )
                .expect("seal");
            let now = seru24_core::chat::now_iso_utc();
            let res = send_with_offline_time(&client.rpc, &sealed, &now)
                .await
                .expect("kirim");
            println!("Terkirim: ok={} seq={:?} id={:?}", res.ok, res.seq, res.id);
        }
        "check-db" => {
            if client.restore_session().await != AccountStatus::Ready {
                eprintln!("Belum login.");
                std::process::exit(1);
            }
            let me = client.rpc.me().await.expect("seru24_me gagal");
            println!(
                "[OK] seru24_me: has_keys={} key_version={:?}",
                me.has_keys, me.key_version
            );
            let convs = client
                .rpc
                .list_conversations(&ListConversationsOptions {
                    limit: Some(50),
                    offset: Some(0),
                    id: None,
                })
                .await
                .expect("seru24_list_conversations gagal (cek migrasi 20261119100000)");
            println!(
                "[OK] seru24_list_conversations(p_limit,p_offset): {} baris",
                convs.len()
            );
            if let Some(conv) = convs.first() {
                let msgs = client
                    .rpc
                    .get_messages(&conv.id, None, 3)
                    .await
                    .expect("seru24_get_messages gagal (cek migrasi 20261120100000)");
                println!(
                    "[OK] seru24_get_messages(offline_sent_at schema): {} baris (sample offline_sent_at present={})",
                    msgs.len(),
                    msgs.iter().any(|m| m.offline_sent_at.is_some())
                );
                let sched = client
                    .rpc
                    .list_scheduled(&conv.id)
                    .await
                    .expect("seru24_list_scheduled gagal (cek migrasi 20261119130000)");
                println!("[OK] seru24_list_scheduled: {} baris", sched.len());
                let peer_seq = client
                    .rpc
                    .peer_read_seq(&conv.id)
                    .await
                    .expect("seru24_peer_read_seq gagal (cek migrasi 20261118110000)");
                println!("[OK] seru24_peer_read_seq: {peer_seq}");
                let pks = client
                    .rpc
                    .get_public_keys(&conv.peer_id)
                    .await
                    .expect("seru24_get_public_keys gagal");
                println!("[OK] seru24_get_public_keys: {} versi kunci", pks.len());
            }
            match client
                .secure
                .get_json::<serde_json::Value>("/api/app/latest")
                .await
            {
                Ok(v) => println!(
                    "[OK] GET /api/app/latest: keys={:?}",
                    v.as_object().map(|o| o.keys().cloned().collect::<Vec<_>>())
                ),
                Err(e) => println!("[WARN] GET /api/app/latest: {e}"),
            }
        }
        other => {
            eprintln!("Perintah tidak dikenal: {other}");
            std::process::exit(2);
        }
    }
}
