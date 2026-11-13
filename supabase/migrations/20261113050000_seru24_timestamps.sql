-- seru24: standar kolom waktu di semua tabel.
-- Dijalankan MANUAL oleh pemilik proyek, setelah 20261113040000_seru24_auth_log.sql.
--
-- Aturan:
--  - created_at  : semua tabel.
--  - updated_at  : semua tabel kecuali system_logs (hanya-tambah, OWASP ASVS V7.3.3); diisi trigger.
--  - deleted_at  : tabel entitas (soft delete). Tidak dipakai pada log, penghitung, dan pengaturan 1:1
--                  (system_logs, rate_limits, daily_stats, user_stats, user_settings) karena barisnya
--                  dibersihkan job atau ikut terhapus bersama profil.
--  - Fungsi yang membaca data mengabaikan baris dengan deleted_at terisi; "hapus" mengisi deleted_at.

begin;

create function seru24.set_updated_at() returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

do $$
declare
  v_table text;
begin
  foreach v_table in array array[
    'profiles', 'user_settings', 'user_keys', 'key_backups', 'conversations', 'conversation_members',
    'attachments', 'messages', 'user_blocks', 'push_tokens', 'user_devices', 'user_stats',
    'daily_stats', 'reports', 'app_admins', 'rate_limits'
  ] loop
    execute format('alter table seru24.%I add column if not exists created_at timestamptz not null default now()', v_table);
    execute format('alter table seru24.%I add column if not exists updated_at timestamptz not null default now()', v_table);
    execute format('create trigger %I before update on seru24.%I for each row execute function seru24.set_updated_at()',
                   v_table || '_set_updated_at', v_table);
  end loop;

  foreach v_table in array array[
    'profiles', 'user_keys', 'key_backups', 'conversations', 'conversation_members', 'attachments',
    'user_blocks', 'push_tokens', 'user_devices', 'reports', 'app_admins'
  ] loop
    execute format('alter table seru24.%I add column if not exists deleted_at timestamptz', v_table);
  end loop;
end;
$$;

-- ===========================================================================
-- Fungsi bantu: abaikan baris yang sudah dihapus
-- ===========================================================================

create or replace function seru24.require_user() returns uuid
language plpgsql stable
set search_path = ''
as $$
declare
  v_user uuid := auth.uid();
begin
  if v_user is null then
    raise exception 'tidak terautentikasi' using errcode = '28000';
  end if;
  if exists (select 1 from seru24.profiles p
             where p.id = v_user and (p.banned_at is not null or p.deleted_at is not null)) then
    raise exception 'akun tidak aktif' using errcode = '42501';
  end if;
  return v_user;
end;
$$;

create or replace function seru24.device_ok(p_user uuid) returns boolean
language sql stable
set search_path = ''
as $$
  select exists (
    select 1 from seru24.user_devices d
    where d.user_id = p_user
      and d.visitor_key_hash = seru24.visitor_key_hash()
      and d.revoked_at is null
      and d.deleted_at is null
  )
$$;

create or replace function seru24.is_member(p_conversation uuid, p_user uuid) returns boolean
language sql stable
set search_path = ''
as $$
  select exists (
    select 1 from seru24.conversation_members m
    join seru24.conversations c on c.id = m.conversation_id
    where m.conversation_id = p_conversation and m.user_id = p_user
      and m.deleted_at is null and c.deleted_at is null
  )
$$;

create or replace function seru24.peer_of(p_conversation uuid, p_user uuid) returns uuid
language sql stable
set search_path = ''
as $$
  select m.user_id from seru24.conversation_members m
  where m.conversation_id = p_conversation and m.user_id <> p_user and m.deleted_at is null
  limit 1
$$;

create or replace function seru24.is_blocked_between(p_a uuid, p_b uuid) returns boolean
language sql stable
set search_path = ''
as $$
  select exists (
    select 1 from seru24.user_blocks b
    where b.deleted_at is null
      and ((b.blocker_id = p_a and b.blocked_id = p_b) or (b.blocker_id = p_b and b.blocked_id = p_a))
  )
$$;

-- profil aktif = tidak dibanned dan tidak dihapus
create function seru24.is_active_profile(p_user uuid) returns boolean
language sql stable
set search_path = ''
as $$
  select exists (
    select 1 from seru24.profiles p
    where p.id = p_user and p.banned_at is null and p.deleted_at is null
  )
$$;

-- kunci publik yang masih berlaku
create function seru24.key_valid(p_user uuid, p_version smallint) returns boolean
language sql stable
set search_path = ''
as $$
  select exists (
    select 1 from seru24.user_keys k
    where k.user_id = p_user and k.key_version = p_version
      and k.revoked_at is null and k.deleted_at is null
  )
$$;

-- ===========================================================================
-- RPC yang terdampak (signature sama, hak akses tetap)
-- ===========================================================================

create or replace function public.seru24_register_device(p_platform text, p_name text, p_after_login boolean default false)
returns jsonb
language plpgsql security definer
set search_path = ''
as $$
declare
  v_user uuid := seru24.require_user();
  v_hash char(64) := seru24.visitor_key_hash();
  v_device seru24.user_devices%rowtype;
  v_is_new boolean;
begin
  if v_hash is null then
    raise exception 'header x-visitor-key wajib' using errcode = '22023';
  end if;

  insert into seru24.user_devices (user_id, visitor_key_hash, platform, name)
  values (v_user, v_hash, p_platform, left(p_name, 60))
  on conflict (user_id, visitor_key_hash)
    do update set last_seen_at = now(), platform = excluded.platform, deleted_at = null
  returning * into v_device;
  v_is_new := v_device.first_seen_at = v_device.last_seen_at;

  if v_device.revoked_at is not null then
    perform seru24.write_log('warning', 'device', 'access_denied', 'Perangkat yang dicabut mencoba masuk', null, 403);
    raise exception 'perangkat tidak diizinkan' using errcode = '42501';
  end if;

  if v_is_new then
    perform seru24.write_log('notice', 'device', 'new_device', 'Perangkat baru terdaftar',
                             jsonb_build_object('platform', p_platform));
  end if;

  if p_after_login then
    update seru24.user_stats
       set login_count = login_count + 1, failed_login_count = 0,
           last_login_at = now(), last_active_at = now()
     where user_id = v_user;
  end if;

  return jsonb_build_object('is_new', v_is_new, 'trusted', v_device.trusted_at is not null);
end;
$$;

create or replace function public.seru24_me() returns jsonb
language plpgsql stable security definer
set search_path = ''
as $$
declare
  v_user uuid := seru24.require_user();
begin
  return (
    select jsonb_build_object(
      'id', p.id,
      'username', p.username,
      'display_name', p.display_name,
      'has_keys', exists (select 1 from seru24.key_backups k where k.user_id = v_user and k.deleted_at is null),
      'key_version', (select max(k.key_version) from seru24.user_keys k
                      where k.user_id = v_user and k.revoked_at is null and k.deleted_at is null))
    from seru24.profiles p where p.id = v_user);
end;
$$;

create or replace function public.seru24_get_key_backup() returns jsonb
language plpgsql security definer
set search_path = ''
as $$
declare
  v_user uuid := seru24.require_user();
begin
  if not seru24.device_ok(v_user) then
    return null;
  end if;
  if not seru24.rate_limit_ok('key_backup', 10, interval '1 hour') then
    perform seru24.write_log('warning', 'security', 'rate_limited', 'Permintaan backup kunci dibatasi', null, 429);
    return null;
  end if;
  return (
    select jsonb_build_object('encrypted_keys', k.encrypted_keys, 'nonce', k.nonce,
                              'kdf', k.kdf, 'kdf_params', k.kdf_params)
    from seru24.key_backups k where k.user_id = v_user and k.deleted_at is null);
end;
$$;

create or replace function public.seru24_get_public_keys(p_user uuid)
returns table (key_version smallint, public_key text, revoked boolean)
language plpgsql stable security definer
set search_path = ''
as $$
begin
  perform seru24.require_user();
  return query
    select k.key_version, k.public_key::text, k.revoked_at is not null
    from seru24.user_keys k
    where k.user_id = p_user and k.deleted_at is null
    order by k.key_version;
end;
$$;

create or replace function public.seru24_search_user(p_username text)
returns table (id uuid, username text, display_name text)
language plpgsql security definer
set search_path = ''
as $$
declare
  v_user uuid := seru24.require_user();
begin
  if not seru24.rate_limit_ok('search_user', 20, interval '1 minute') then
    perform seru24.write_log('warning', 'security', 'rate_limited', 'Pencarian pengguna dibatasi', null, 429);
    return;
  end if;
  if p_username is null or p_username !~ '^[a-z0-9_]{3,30}$' then
    return;
  end if;
  return query
    select p.id, p.username::text, p.display_name::text
    from seru24.profiles p
    where p.username = p_username::extensions.citext
      and p.id <> v_user
      and p.banned_at is null
      and p.deleted_at is null
      and not exists (select 1 from seru24.user_blocks b
                      where b.blocker_id = p.id and b.blocked_id = v_user and b.deleted_at is null)
    limit 1;
end;
$$;

create or replace function public.seru24_start_direct_chat(p_target uuid) returns jsonb
language plpgsql security definer
set search_path = ''
as $$
declare
  v_user uuid := seru24.require_user();
  v_key text;
  v_conversation uuid;
begin
  if p_target is null or p_target = v_user
     or not seru24.is_active_profile(p_target)
     or seru24.is_blocked_between(v_user, p_target) then
    return jsonb_build_object('ok', false, 'code', 'unavailable');
  end if;

  v_key := least(v_user::text, p_target::text) || ':' || greatest(v_user::text, p_target::text);
  select c.id into v_conversation from seru24.conversations c where c.direct_key = v_key;
  if v_conversation is not null then
    -- percakapan yang pernah dihapus dipulihkan, bukan dibuat ganda
    update seru24.conversations set deleted_at = null where id = v_conversation and deleted_at is not null;
    update seru24.conversation_members set deleted_at = null
     where conversation_id = v_conversation and deleted_at is not null;
    return jsonb_build_object('ok', true, 'conversation_id', v_conversation);
  end if;

  if not seru24.rate_limit_ok('start_chat', 30, interval '1 hour') then
    perform seru24.write_log('warning', 'security', 'rate_limited', 'Pembuatan percakapan dibatasi', null, 429);
    return jsonb_build_object('ok', false, 'code', 'rate_limited');
  end if;

  insert into seru24.conversations (direct_key, status, requested_by)
  values (v_key, 'pending', v_user)
  on conflict (direct_key) do nothing
  returning id into v_conversation;

  if v_conversation is null then
    select c.id into v_conversation from seru24.conversations c where c.direct_key = v_key;
  else
    insert into seru24.conversation_members (conversation_id, user_id)
    values (v_conversation, v_user), (v_conversation, p_target);
  end if;

  return jsonb_build_object('ok', true, 'conversation_id', v_conversation);
end;
$$;

create or replace function public.seru24_list_conversations()
returns table (
  id uuid, status text, requested_by uuid, last_message_at timestamptz, unread bigint,
  muted boolean, archived boolean, pinned boolean,
  peer_id uuid, peer_username text, peer_display_name text, peer_blocked boolean
)
language plpgsql stable security definer
set search_path = ''
as $$
declare
  v_user uuid := seru24.require_user();
begin
  return query
    select c.id, c.status::text, c.requested_by, c.last_message_at,
           greatest(c.last_seq - m.last_read_seq, 0),
           m.muted, m.archived, m.pinned,
           p.id, p.username::text, p.display_name::text,
           exists (select 1 from seru24.user_blocks b
                   where b.blocker_id = v_user and b.blocked_id = p.id and b.deleted_at is null)
    from seru24.conversation_members m
    join seru24.conversations c on c.id = m.conversation_id and c.deleted_at is null
    join seru24.conversation_members pm on pm.conversation_id = c.id and pm.user_id <> v_user
    join seru24.profiles p on p.id = pm.user_id
    where m.user_id = v_user and m.deleted_at is null
    order by m.pinned desc, c.last_message_at desc nulls last;
end;
$$;

create or replace function public.seru24_send_message(
  p_conversation_id uuid, p_client_msg_id uuid, p_kind text,
  p_ciphertext text, p_nonce text,
  p_sender_key_version smallint, p_recipient_key_version smallint,
  p_reply_to uuid default null
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
    when p_kind <> 'text' then 'unsupported_kind'
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
     sender_key_version, recipient_key_version, reply_to, expires_at)
  values
    (p_conversation_id, v_user, v_conversation.last_seq, p_client_msg_id, p_kind, p_ciphertext, p_nonce,
     p_sender_key_version, p_recipient_key_version, p_reply_to,
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

create or replace function public.seru24_block_user(p_target uuid) returns void
language plpgsql security definer
set search_path = ''
as $$
declare
  v_user uuid := seru24.require_user();
begin
  if p_target is null or p_target = v_user then
    return;
  end if;
  insert into seru24.user_blocks (blocker_id, blocked_id) values (v_user, p_target)
  on conflict (blocker_id, blocked_id)
    do update set deleted_at = null
    where seru24.user_blocks.deleted_at is not null;
  if found then
    perform seru24.write_log('info', 'security', 'user_blocked', 'Pengguna diblokir');
  end if;
end;
$$;

-- buka blokir = soft delete
create or replace function public.seru24_unblock_user(p_target uuid) returns void
language plpgsql security definer
set search_path = ''
as $$
declare
  v_user uuid := seru24.require_user();
begin
  update seru24.user_blocks set deleted_at = now()
   where blocker_id = v_user and blocked_id = p_target and deleted_at is null;
end;
$$;

create or replace function public.seru24_report_user(p_target uuid, p_reason text, p_note text default null) returns jsonb
language plpgsql security definer
set search_path = ''
as $$
declare
  v_user uuid := seru24.require_user();
begin
  if p_target is null or p_target = v_user
     or not exists (select 1 from seru24.profiles p where p.id = p_target and p.deleted_at is null) then
    return jsonb_build_object('ok', false, 'code', 'invalid_target');
  end if;
  if not seru24.rate_limit_ok('report_user', 10, interval '1 day') then
    return jsonb_build_object('ok', false, 'code', 'rate_limited');
  end if;
  insert into seru24.reports (reporter_id, reported_user_id, reason, note)
  values (v_user, p_target, p_reason, left(p_note, 500));
  update seru24.user_stats set reports_received = reports_received + 1 where user_id = p_target;
  perform seru24.write_log('notice', 'admin', 'user_reported', 'Laporan pengguna baru',
                           jsonb_build_object('reported_user_id', p_target, 'reason', p_reason));
  return jsonb_build_object('ok', true);
end;
$$;

-- fungsi bantu baru di schema seru24 tidak boleh dipanggil client
revoke all on function seru24.set_updated_at(), seru24.is_active_profile(uuid), seru24.key_valid(uuid, smallint)
  from public, anon, authenticated;

commit;
