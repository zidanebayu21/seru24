-- seru24: dokumen chat disimpan di Google Drive akun penyimpanan aplikasi (folder seru24/<conversation_id>).
-- Isi file dienkripsi di browser pengirim (AES-256-GCM, kunci di dalam pesan E2EE); Drive hanya menerima blob acak.
-- Dijalankan MANUAL oleh pemilik proyek, setelah 20261113100000_seru24_daily_stats_and_prune.sql.

begin;

-- 1. attachments: batas 50 MiB (+16 byte tag GCM) dan kolom Drive.
alter table seru24.attachments drop constraint if exists attachments_size_bytes_check;
alter table seru24.attachments
  add constraint attachments_size_bytes_check check (size_bytes between 1 and 52428816),
  add column if not exists drive_file_id  varchar(128),
  add column if not exists upload_session text,
  add column if not exists status         varchar(10) not null default 'uploading'
    check (status in ('uploading', 'ready', 'deleted'));
create index if not exists attachments_uploader_created_idx on seru24.attachments (uploader_id, created_at);

-- 2. Fungsi khusus server (service_role); dipanggil endpoint /api/files/* setelah token pengguna diverifikasi.

create function public.seru24_file_begin(p_user uuid, p_conversation_id uuid, p_size int)
returns jsonb
language plpgsql security definer
set search_path = ''
as $$
declare
  v_peer uuid := seru24.peer_of(p_conversation_id, p_user);
  v_id uuid := gen_random_uuid();
  v_code text;
begin
  v_code := case
    when p_size is null or p_size < 1 or p_size > 52428816 then 'too_large'
    when not seru24.is_member(p_conversation_id, p_user) then 'not_member'
    when v_peer is null or seru24.is_blocked_between(p_user, v_peer) or not seru24.is_active_profile(v_peer) then 'unavailable'
    when (select count(*) from seru24.attachments a
           where a.uploader_id = p_user and a.created_at > now() - interval '1 hour') >= 100 then 'rate_limited'
    else null
  end;
  if v_code is not null then
    return jsonb_build_object('ok', false, 'code', v_code);
  end if;

  insert into seru24.attachments (id, conversation_id, uploader_id, storage_path, size_bytes)
  values (v_id, p_conversation_id, p_user, 'seru24/' || p_conversation_id || '/' || v_id, p_size);
  return jsonb_build_object('ok', true, 'id', v_id);
end;
$$;

create function public.seru24_file_set_session(p_id uuid, p_user uuid, p_session text)
returns boolean
language plpgsql security definer
set search_path = ''
as $$
begin
  update seru24.attachments a set upload_session = p_session
   where a.id = p_id and a.uploader_id = p_user and a.status = 'uploading' and a.upload_session is null;
  return found;
end;
$$;

-- Sesi upload hanya untuk pengunggahnya, dan kedaluwarsa setelah 1 hari (sesi resumable Drive berlaku 1 minggu).
create function public.seru24_file_for_upload(p_id uuid, p_user uuid)
returns jsonb
language sql stable security definer
set search_path = ''
as $$
  select jsonb_build_object('session', a.upload_session, 'size', a.size_bytes)
  from seru24.attachments a
  where a.id = p_id and a.uploader_id = p_user and a.status = 'uploading'
    and a.upload_session is not null and a.created_at > now() - interval '1 day'
$$;

create function public.seru24_file_finish(p_id uuid, p_user uuid, p_drive_file_id text)
returns boolean
language plpgsql security definer
set search_path = ''
as $$
begin
  update seru24.attachments a
     set status = 'ready', drive_file_id = p_drive_file_id, upload_session = null
   where a.id = p_id and a.uploader_id = p_user and a.status = 'uploading';
  return found;
end;
$$;

-- Unduh: hanya anggota percakapan yang masih aktif.
create function public.seru24_file_for_download(p_id uuid, p_user uuid)
returns jsonb
language sql stable security definer
set search_path = ''
as $$
  select jsonb_build_object('drive_file_id', a.drive_file_id, 'size', a.size_bytes)
  from seru24.attachments a
  where a.id = p_id and a.status = 'ready' and seru24.is_member(a.conversation_id, p_user)
$$;

-- Hapus: hanya pengunggah. Mengembalikan id Drive agar server menghapus filenya.
create function public.seru24_file_delete(p_id uuid, p_user uuid)
returns jsonb
language plpgsql security definer
set search_path = ''
as $$
declare
  v_drive text;
begin
  update seru24.attachments a
     set status = 'deleted', deleted_at = now(), upload_session = null
   where a.id = p_id and a.uploader_id = p_user and a.status <> 'deleted'
  returning a.drive_file_id into v_drive;
  if not found then
    return jsonb_build_object('ok', false);
  end if;
  return jsonb_build_object('ok', true, 'drive_file_id', v_drive);
end;
$$;

do $$
declare
  v_sig text;
begin
  foreach v_sig in array array[
    'public.seru24_file_begin(uuid, uuid, int)',
    'public.seru24_file_set_session(uuid, uuid, text)',
    'public.seru24_file_for_upload(uuid, uuid)',
    'public.seru24_file_finish(uuid, uuid, text)',
    'public.seru24_file_for_download(uuid, uuid)',
    'public.seru24_file_delete(uuid, uuid)'
  ] loop
    execute format('revoke all on function %s from public, anon, authenticated', v_sig);
    execute format('grant execute on function %s to service_role', v_sig);
  end loop;
end;
$$;

-- 3. seru24_send_message menerima kind 'file' dengan lampiran milik pengirim yang sudah selesai diunggah.
drop function public.seru24_send_message(uuid, uuid, text, text, text, smallint, smallint, uuid);

create function public.seru24_send_message(
  p_conversation_id uuid, p_client_msg_id uuid, p_kind text,
  p_ciphertext text, p_nonce text,
  p_sender_key_version smallint, p_recipient_key_version smallint,
  p_reply_to uuid default null, p_attachment_id uuid default null
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
begin
  -- idempoten: kirim ulang dengan client_msg_id yang sama mengembalikan pesan yang sudah ada
  select * into v_existing from seru24.messages m
   where m.sender_id = v_user and m.client_msg_id = p_client_msg_id;
  if found then
    return jsonb_build_object('ok', true, 'code', 'duplicate', 'id', v_existing.id,
                              'seq', v_existing.seq, 'created_at', v_existing.created_at);
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
     sender_key_version, recipient_key_version, reply_to, attachment_id, expires_at)
  values
    (p_conversation_id, v_user, v_conversation.last_seq, p_client_msg_id, p_kind, p_ciphertext, p_nonce,
     p_sender_key_version, p_recipient_key_version, p_reply_to, p_attachment_id,
     case when v_conversation.disappear_after_seconds is not null
          then now() + make_interval(secs => v_conversation.disappear_after_seconds) end)
  returning * into v_message;

  update seru24.conversation_members set last_read_seq = v_message.seq
   where conversation_id = p_conversation_id and user_id = v_user;
  update seru24.user_stats
     set messages_sent = messages_sent + 1, last_active_at = now()
   where user_id = v_user;

  return jsonb_build_object('ok', true, 'id', v_message.id, 'seq', v_message.seq,
                            'created_at', v_message.created_at, 'expires_at', v_message.expires_at);
end;
$$;

revoke all on function public.seru24_send_message(uuid, uuid, text, text, text, smallint, smallint, uuid, uuid)
  from public, anon;
grant execute on function public.seru24_send_message(uuid, uuid, text, text, text, smallint, smallint, uuid, uuid)
  to authenticated;

commit;
