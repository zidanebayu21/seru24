// Prototipe Slint: 200 chat tiruan, 500 pesan per chat (termasuk pesan "revisi" berwarna pink), kirim pesan lokal.
// Tujuan: mengukur RAM dan ukuran biner, serta menilai teks dan input; belum terhubung ke Supabase.
use std::rc::Rc;

use slint::{ModelRc, SharedString, VecModel};

slint::include_modules!();

const CHAT_COUNT: usize = 200;
const MESSAGES_PER_CHAT: usize = 500;

fn mock_chats() -> Vec<ChatItem> {
    (0..CHAT_COUNT)
        .map(|i| {
            let name = format!("pengguna_{i:03}");
            ChatItem {
                initial: name.chars().next().unwrap_or('?').to_uppercase().to_string().into(),
                last: "Pesan terakhir di percakapan ini".into(),
                name: name.into(),
                time: format!("{:02}.{:02}", (i * 7) % 24, (i * 13) % 60).into(),
                unread: (i % 5) as i32,
            }
        })
        .collect()
}

fn mock_bubbles(chat: usize) -> Vec<Bubble> {
    (0..MESSAGES_PER_CHAT)
        .map(|n| Bubble {
            text: format!("Pesan #{n} di chat {chat}: teks agak panjang supaya terbungkus ke beberapa baris di layar sempit.").into(),
            time: format!("{:02}.{:02}", (n / 60) % 24, n % 60).into(),
            mine: n % 3 == 0,
            revised: n % 17 == 0,
        })
        .collect()
}

fn main() -> Result<(), slint::PlatformError> {
    let ui = AppWindow::new()?;
    ui.set_chats(ModelRc::from(Rc::new(VecModel::from(mock_chats()))));

    let bubbles = Rc::new(VecModel::<Bubble>::default());
    ui.set_bubbles(ModelRc::from(bubbles.clone()));

    let weak = ui.as_weak();
    let open_bubbles = bubbles.clone();
    ui.on_open(move |index| {
        open_bubbles.set_vec(mock_bubbles(index as usize));
        if let Some(ui) = weak.upgrade() {
            ui.set_open_chat(index);
        }
    });

    let weak = ui.as_weak();
    ui.on_back(move || {
        if let Some(ui) = weak.upgrade() {
            ui.set_open_chat(-1);
        }
    });

    let weak = ui.as_weak();
    ui.on_send(move |text: SharedString| {
        let text = text.trim();
        if text.is_empty() {
            return;
        }
        bubbles.push(Bubble { text: text.into(), time: "baru".into(), mine: true, revised: false });
        if let Some(ui) = weak.upgrade() {
            ui.set_draft(SharedString::new());
        }
    });

    ui.run()
}
