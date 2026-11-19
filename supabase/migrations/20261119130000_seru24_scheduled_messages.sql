-- Kirim pesan terjadwal. Pesan dienkripsi di perangkat pengirim saat dijadwalkan; server hanya menyimpan ciphertext
-- dan melepasnya pada waktunya (server tetap tidak bisa membaca isi). Pengirim bisa melihat dan membatalkan jadwalnya.
-- Rujukan: OWASP ASVS V4.1 (akses hanya milik pengirim), V8.3 (data sensitif tidak diekspos), V11.1 (batas logika bisnis).
-- Pesan terjadwal hanya teks; dokumen tidak bisa dijadwalkan.

begin;

create table if not exists seru24.scheduled_messages (
  id                    uuid primary key default gen_random_uuid(),
  conversation_id       uuid not null references seru24.conversations (id) on delete cascade,
  sender_id             uuid not null references seru24.profiles (id) on delete cascade,
  client_msg_id         uuid not null,
  ciphertext            text not null,
  nonce                 text not null,
  sender_key_version    smallint not null,
  recipient_key_version smallint not null,
  reply_to              uuid,
  send_at               timestamptz not null,
  status                text not null default 'pending' check (status in ('pending', 'sent', 'failed', 'cancelled')),
  error_code            text,
  created_at            timestamptz not null default now(),
  processed_at          timestamptz,
  unique (sender_id, client_msg_id)
);

create index if not exists scheduled_messages_due_idx on seru24.scheduled_messages (send_at) where status = 'pending';
create index if not exists scheduled_messages_sender_idx on seru24.scheduled_messages (sender_id, conversation_id);

-- hanya diakses lewat fungsi security definer di bawah
alter table seru24.scheduled_messages enable row level security;
revoke all on seru24.scheduled_messages from public, anon, authenticated;

-- 1. jadwalkan
create or replace function public.seru24_schedule_message(
  p_conversation_id uuid, p_client_msg_id uuid,
  p_ciphertext text, p_nonce text,
  p_sender_key_version smallint, p_recipient_key_version smallint,
  p_send_at timestamptz,
  p_reply_to uuid default null
) returns jsonb
language plpgsql security definer
set search_path = ''
as $$
declare
  v_user uuid := seru24.require_user();
  v_peer uuid;
  v_code text;
  v_row seru24.scheduled_messages%rowtype;
begin
  select * into v_row from seru24.scheduled_messages s
   where s.sender_id = v_user and s.client_msg_id = p_client_msg_id;
  if found then
    return jsonb_build_object('ok', true, 'code', 'duplicate', 'id', v_row.id, 'send_at', v_row.send_at);
  end if;

  v_peer := seru24.peer_of(p_conversation_id, v_user);

  v_code := case
    when not seru24.device_ok(v_user) then 'device_not_registered'
    when not seru24.is_member(p_conversation_id, v_user) then 'not_member'
    when seru24.is_blocked_between(v_user, v_peer) or not seru24.is_active_profile(v_peer) then 'unavailable'
    when p_send_at < now() + interval '30 seconds' then 'too_soon'
    when p_send_at > now() + interval '30 days' then 'too_far'
    when not seru24.key_valid(v_user, p_sender_key_version)
      or not seru24.key_valid(v_peer, p_recipient_key_version) then 'stale_key'
    when p_reply_to is not null and not exists (select 1 from seru24.messages r
                       where r.id = p_reply_to and r.conversation_id = p_conversation_id) then 'invalid_reply'
    when (select count(*) from seru24.scheduled_messages s
           where s.sender_id = v_user and s.status = 'pending') >= 20 then 'too_many'
    when not seru24.rate_limit_ok('schedule_message', 20, interval '1 minute') then 'rate_limited'
    else null
  end;

  if v_code is not null then
    return jsonb_build_object('ok', false, 'code', v_code);
  end if;

  insert into seru24.scheduled_messages
    (conversation_id, sender_id, client_msg_id, ciphertext, nonce,
     sender_key_version, recipient_key_version, reply_to, send_at)
  values
    (p_conversation_id, v_user, p_client_msg_id, p_ciphertext, p_nonce,
     p_sender_key_version, p_recipient_key_version, p_reply_to, p_send_at)
  returning * into v_row;

  return jsonb_build_object('ok', true, 'id', v_row.id, 'send_at', v_row.send_at);
end;
$$;

-- 2. daftar jadwal milik pengirim di satu percakapan (yang menunggu, plus yang gagal 7 hari terakhir)
create or replace function public.seru24_list_scheduled(p_conversation_id uuid)
returns table (
  id uuid, client_msg_id uuid, ciphertext text, nonce text,
  sender_key_version smallint, recipient_key_version smallint,
  send_at timestamptz, status text, error_code text
)
language plpgsql stable security definer
set search_path = ''
as $$
declare
  v_user uuid := seru24.require_user();
begin
  return query
    select s.id, s.client_msg_id, s.ciphertext, s.nonce, s.sender_key_version, s.recipient_key_version,
           s.send_at, s.status, s.error_code
      from seru24.scheduled_messages s
     where s.sender_id = v_user and s.conversation_id = p_conversation_id
       and (s.status = 'pending' or (s.status = 'failed' and s.processed_at > now() - interval '7 days'))
     order by s.send_at;
end;
$$;

-- 3. batalkan (juga membuang jadwal gagal dari daftar)
create or replace function public.seru24_cancel_scheduled(p_id uuid) returns boolean
language plpgsql security definer
set search_path = ''
as $$
declare
  v_user uuid := seru24.require_user();
  v_count int;
begin
  update seru24.scheduled_messages
     set status = 'cancelled', processed_at = now(), ciphertext = '', nonce = ''
   where id = p_id and sender_id = v_user and status in ('pending', 'failed');
  get diagnostics v_count = row_count;
  return v_count > 0;
end;
$$;

-- 4. pengirim jadwal: dipanggil pg_cron tiap menit. Pemeriksaan perangkat sudah dilakukan saat menjadwalkan
-- (device_ok memakai header permintaan sehingga tidak berlaku di sini); sisanya sama dengan seru24_send_message.
create or replace function seru24.dispatch_scheduled_messages() returns int
language plpgsql security definer
set search_path = ''
as $$
declare
  v_row seru24.scheduled_messages%rowtype;
  v_conversation seru24.conversations%rowtype;
  v_peer uuid;
  v_code text;
  v_sent int := 0;
begin
  for v_row in
    select * from seru24.scheduled_messages s
     where s.status = 'pending' and s.send_at <= now()
     order by s.send_at
     limit 200
     for update skip locked
  loop
    v_code := null;
    begin
      if exists (select 1 from seru24.messages m where m.sender_id = v_row.sender_id and m.client_msg_id = v_row.client_msg_id) then
        v_code := null; -- sudah terkirim sebelumnya; tandai selesai saja
      else
        select * into v_conversation from seru24.conversations c where c.id = v_row.conversation_id;
        v_peer := seru24.peer_of(v_row.conversation_id, v_row.sender_id);
        v_code := case
          when v_conversation.id is null or not seru24.is_member(v_row.conversation_id, v_row.sender_id) then 'not_member'
          when exists (select 1 from seru24.profiles p where p.id = v_row.sender_id and p.banned_at is not null) then 'unavailable'
          when seru24.is_blocked_between(v_row.sender_id, v_peer) or not seru24.is_active_profile(v_peer) then 'unavailable'
          when not seru24.key_valid(v_row.sender_id, v_row.sender_key_version)
            or not seru24.key_valid(v_peer, v_row.recipient_key_version) then 'stale_key'
          when v_row.reply_to is not null and not exists (select 1 from seru24.messages r
                             where r.id = v_row.reply_to and r.conversation_id = v_row.conversation_id) then 'invalid_reply'
          else null
        end;

        if v_code is null then
          if v_conversation.status = 'pending' and v_conversation.requested_by is distinct from v_row.sender_id then
            update seru24.conversations set status = 'accepted' where id = v_row.conversation_id;
          end if;

          update seru24.conversations
             set last_seq = last_seq + 1, last_message_at = now()
           where id = v_row.conversation_id
          returning * into v_conversation;

          insert into seru24.messages
            (conversation_id, sender_id, seq, client_msg_id, kind, ciphertext, nonce,
             sender_key_version, recipient_key_version, reply_to, expires_at)
          values
            (v_row.conversation_id, v_row.sender_id, v_conversation.last_seq, v_row.client_msg_id, 'text',
             v_row.ciphertext, v_row.nonce, v_row.sender_key_version, v_row.recipient_key_version, v_row.reply_to,
             case when v_conversation.disappear_after_seconds is not null
                  then now() + make_interval(secs => v_conversation.disappear_after_seconds) end);

          update seru24.conversation_members set last_read_seq = v_conversation.last_seq
           where conversation_id = v_row.conversation_id and user_id = v_row.sender_id;
          update seru24.user_stats
             set messages_sent = messages_sent + 1, last_active_at = now()
           where user_id = v_row.sender_id;
          v_sent := v_sent + 1;
        end if;
      end if;

      update seru24.scheduled_messages
         set status = case when v_code is null then 'sent' else 'failed' end,
             error_code = v_code, processed_at = now(),
             ciphertext = case when v_code is null then '' else ciphertext end,
             nonce = case when v_code is null then '' else nonce end
       where id = v_row.id;
    exception when others then
      -- satu baris bermasalah tidak boleh menghentikan yang lain
      update seru24.scheduled_messages
         set status = 'failed', error_code = 'internal', processed_at = now()
       where id = v_row.id;
    end;
  end loop;

  -- bersihkan catatan lama
  delete from seru24.scheduled_messages
   where status in ('sent', 'cancelled') and processed_at < now() - interval '1 day';
  delete from seru24.scheduled_messages
   where status = 'failed' and processed_at < now() - interval '7 days';

  return v_sent;
end;
$$;

revoke all on function seru24.dispatch_scheduled_messages() from public, anon, authenticated;

revoke all on function public.seru24_schedule_message(uuid, uuid, text, text, smallint, smallint, timestamptz, uuid) from public, anon;
revoke all on function public.seru24_list_scheduled(uuid) from public, anon;
revoke all on function public.seru24_cancel_scheduled(uuid) from public, anon;
grant execute on function public.seru24_schedule_message(uuid, uuid, text, text, smallint, smallint, timestamptz, uuid) to authenticated;
grant execute on function public.seru24_list_scheduled(uuid) to authenticated;
grant execute on function public.seru24_cancel_scheduled(uuid) to authenticated;

-- jalankan tiap menit lewat pg_cron (aman dilewati bila ekstensi belum aktif)
do $$
declare
  v_job_id bigint;
begin
  select jobid into v_job_id from cron.job where jobname = 'seru24_dispatch_scheduled' limit 1;
  if v_job_id is not null then
    perform cron.unschedule(v_job_id);
  end if;
  perform cron.schedule('seru24_dispatch_scheduled', '* * * * *', 'select seru24.dispatch_scheduled_messages();');
exception when others then
  null;
end;
$$;

commit;
