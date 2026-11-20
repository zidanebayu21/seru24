-- seru24: waktu kirim asli untuk pesan yang dikirim saat offline (antrean offline / Siaran Dekat).
-- Tanpa ini pesan itu memakai waktu server saat baru online, sehingga urutan percakapan bergeser ("acak-acakan").
-- Kolom offline_sent_at diisi pengirim; tampilan memakai coalesce(offline_sent_at, created_at) dan menandai
-- bubble sebagai "revisi". Dijalankan MANUAL oleh pemilik proyek, setelah 20261119140000_seru24_schedule_cron.sql.

begin;

alter table seru24.messages add column if not exists offline_sent_at timestamptz;

-- 1. Realtime Broadcast: payload pesan ikut membawa offline_sent_at
create or replace function seru24.broadcast_message() returns trigger
language plpgsql security definer
set search_path = ''
as $$
declare
  v_member record;
  v_payload jsonb := jsonb_build_object(
    'id', new.id, 'conversation_id', new.conversation_id, 'sender_id', new.sender_id,
    'seq', new.seq, 'client_msg_id', new.client_msg_id, 'kind', new.kind,
    'ciphertext', new.ciphertext, 'nonce', new.nonce,
    'sender_key_version', new.sender_key_version, 'recipient_key_version', new.recipient_key_version,
    'reply_to', new.reply_to, 'created_at', new.created_at, 'offline_sent_at', new.offline_sent_at,
    'edited_at', new.edited_at, 'deleted_at', new.deleted_at, 'expires_at', new.expires_at);
begin
  for v_member in
    select m.user_id from seru24.conversation_members m where m.conversation_id = new.conversation_id
  loop
    perform realtime.send(v_payload,
                          case when tg_op = 'INSERT' then 'message_new' else 'message_update' end,
                          'user:' || v_member.user_id::text,
                          true);
  end loop;
  return null;
end;
$$;

-- 2. seru24_get_messages mengembalikan offline_sent_at (tipe kembalian berubah: fungsi dibuat ulang)
drop function public.seru24_get_messages(uuid, bigint, bigint, int);

create function public.seru24_get_messages(
  p_conversation_id uuid, p_after_seq bigint default null, p_before_seq bigint default null, p_limit int default 50
)
returns table (
  id uuid, conversation_id uuid, sender_id uuid, seq bigint, client_msg_id uuid, kind text,
  ciphertext text, nonce text, sender_key_version smallint, recipient_key_version smallint,
  reply_to uuid, created_at timestamptz, offline_sent_at timestamptz,
  edited_at timestamptz, deleted_at timestamptz, expires_at timestamptz
)
language plpgsql stable security definer
set search_path = ''
as $$
declare
  v_user uuid := seru24.require_user();
  v_limit int := least(greatest(coalesce(p_limit, 50), 1), 100);
begin
  if not seru24.is_member(p_conversation_id, v_user) then
    return;
  end if;
  return query
    select m.id, m.conversation_id, m.sender_id, m.seq, m.client_msg_id, m.kind::text,
           m.ciphertext, m.nonce::text, m.sender_key_version, m.recipient_key_version,
           m.reply_to, m.created_at, m.offline_sent_at, m.edited_at, m.deleted_at, m.expires_at
    from seru24.messages m
    where m.conversation_id = p_conversation_id
      and (m.expires_at is null or m.expires_at > now())
      and (p_after_seq is null or m.seq > p_after_seq)
      and (p_before_seq is null or m.seq < p_before_seq)
    order by case when p_after_seq is not null then m.seq end asc,
             case when p_after_seq is null then m.seq end desc
    limit v_limit;
end;
$$;

revoke all on function public.seru24_get_messages(uuid, bigint, bigint, int) from public, anon;
grant execute on function public.seru24_get_messages(uuid, bigint, bigint, int) to authenticated;

-- 3. seru24_send_message menerima p_offline_sent_at. Nilai dari klien dijepit ke [sekarang - 7 hari, sekarang]
-- sehingga tidak bisa dari masa depan dan tidak bisa dimundurkan jauh ke belakang.
drop function public.seru24_send_message(uuid, uuid, text, text, text, smallint, smallint, uuid, uuid);

create function public.seru24_send_message(
  p_conversation_id uuid, p_client_msg_id uuid, p_kind text,
  p_ciphertext text, p_nonce text,
  p_sender_key_version smallint, p_recipient_key_version smallint,
  p_reply_to uuid default null, p_attachment_id uuid default null,
  p_offline_sent_at timestamptz default null
) returns jsonb
language plpgsql security definer
set search_path = ''
as $$
declare
  v_user uuid := seru24.require_user();
  v_existing seru24.messages%rowtype;
  v_conversation seru24.conversations%rowtype;
  v_peer uuid;
  v_code text;
  v_message seru24.messages%rowtype;
  v_offline timestamptz := case when p_offline_sent_at is null then null
                                else least(greatest(p_offline_sent_at, now() - interval '7 days'), now()) end;
begin
  -- idempoten: kirim ulang dengan client_msg_id yang sama mengembalikan pesan yang sudah ada
  select * into v_existing from seru24.messages m
   where m.sender_id = v_user and m.client_msg_id = p_client_msg_id;
  if found then
    return jsonb_build_object('ok', true, 'code', 'duplicate', 'id', v_existing.id,
                              'seq', v_existing.seq, 'created_at', v_existing.created_at,
                              'offline_sent_at', v_existing.offline_sent_at);
  end if;

  select * into v_conversation from seru24.conversations c where c.id = p_conversation_id;
  v_peer := seru24.peer_of(p_conversation_id, v_user);

  v_code := case
    when not seru24.device_ok(v_user) then 'device_not_registered'
    when v_conversation.id is null or not seru24.is_member(p_conversation_id, v_user) then 'not_member'
    when p_kind not in ('text', 'file') then 'unsupported_kind'
    when (p_kind = 'text') <> (p_attachment_id is null) then 'invalid_attachment'
    when p_kind = 'file' and not exists (
           select 1 from seru24.attachments a
            where a.id = p_attachment_id and a.conversation_id = p_conversation_id
              and a.uploader_id = v_user and a.status = 'ready'
              and not exists (select 1 from seru24.messages u where u.attachment_id = a.id)) then 'invalid_attachment'
    when seru24.is_blocked_between(v_user, v_peer) then 'unavailable'
    when not seru24.is_active_profile(v_peer) then 'unavailable'
    when not seru24.key_valid(v_user, p_sender_key_version)
      or not seru24.key_valid(v_peer, p_recipient_key_version) then 'stale_key'
    when p_reply_to is not null and not exists (select 1 from seru24.messages r
                       where r.id = p_reply_to and r.conversation_id = p_conversation_id) then 'invalid_reply'
    when not seru24.rate_limit_ok('send_message', 60, interval '1 minute') then 'rate_limited'
    else null
  end;

  if v_code is not null then
    update seru24.user_stats set messages_rejected = messages_rejected + 1 where user_id = v_user;
    perform seru24.write_log('warning', 'chat', 'message_rejected', 'Pesan ditolak',
                             jsonb_build_object('code', v_code, 'conversation_id', p_conversation_id),
                             case v_code when 'rate_limited' then 429 when 'stale_key' then 409 else 403 end);
    -- 'unavailable' sengaja generik: pengirim tidak diberi tahu bahwa ia diblokir
    return jsonb_build_object('ok', false, 'code', v_code);
  end if;

  -- balasan dari penerima permintaan chat = menerima percakapan
  if v_conversation.status = 'pending' and v_conversation.requested_by is distinct from v_user then
    update seru24.conversations set status = 'accepted' where id = p_conversation_id;
  end if;

  update seru24.conversations
     set last_seq = last_seq + 1, last_message_at = now()
   where id = p_conversation_id
  returning * into v_conversation;

  insert into seru24.messages
    (conversation_id, sender_id, seq, client_msg_id, kind, ciphertext, nonce,
     sender_key_version, recipient_key_version, reply_to, attachment_id, offline_sent_at, expires_at)
  values
    (p_conversation_id, v_user, v_conversation.last_seq, p_client_msg_id, p_kind, p_ciphertext, p_nonce,
     p_sender_key_version, p_recipient_key_version, p_reply_to, p_attachment_id, v_offline,
     case when v_conversation.disappear_after_seconds is not null
          then now() + make_interval(secs => v_conversation.disappear_after_seconds) end)
  returning * into v_message;

  update seru24.conversation_members set last_read_seq = v_message.seq
   where conversation_id = p_conversation_id and user_id = v_user;
  update seru24.user_stats
     set messages_sent = messages_sent + 1, last_active_at = now()
   where user_id = v_user;

  return jsonb_build_object('ok', true, 'id', v_message.id, 'seq', v_message.seq,
                            'created_at', v_message.created_at, 'offline_sent_at', v_message.offline_sent_at,
                            'expires_at', v_message.expires_at);
end;
$$;

revoke all on function public.seru24_send_message(uuid, uuid, text, text, text, smallint, smallint, uuid, uuid, timestamptz)
  from public, anon;
grant execute on function public.seru24_send_message(uuid, uuid, text, text, text, smallint, smallint, uuid, uuid, timestamptz)
  to authenticated;

commit;
