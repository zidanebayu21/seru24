-- seru24: fungsi bantu, trigger, RPC untuk client, dan Realtime Broadcast.
-- Sumber rancangan: doc/database.md
-- Dijalankan MANUAL oleh pemilik proyek, setelah 20261113000000_seru24_tables.sql.
--
-- Pola keamanan (OWASP ASVS V4):
--  - Tabel ada di schema seru24 yang tidak dibuka ke API.
--  - Client hanya bisa memanggil fungsi public.seru24_* (security definer, search_path kosong).
--  - Penolakan yang perlu dihitung (rate limit, blokir) dikembalikan sebagai kode, bukan exception,
--    karena exception membatalkan transaksi sehingga penghitung dan log ikut hilang.

begin;

create extension if not exists pgcrypto schema extensions;

-- ===========================================================================
-- Fungsi bantu (schema seru24, tidak bisa dipanggil client)
-- ===========================================================================

create function seru24.request_header(p_name text) returns text
language sql stable
set search_path = ''
as $$
  select (nullif(current_setting('request.headers', true), '')::json) ->> p_name
$$;

create function seru24.client_ip() returns inet
language plpgsql stable
set search_path = ''
as $$
begin
  return nullif(trim(split_part(coalesce(seru24.request_header('x-forwarded-for'), ''), ',', 1)), '')::inet;
exception when others then
  return null;
end;
$$;

-- Hanya hash sha256 dari header x-visitor-key yang dipakai/disimpan; nilai asli tidak pernah ditulis.
create function seru24.visitor_key_hash() returns char(64)
language plpgsql stable
set search_path = ''
as $$
declare
  v_raw text := seru24.request_header('x-visitor-key');
begin
  if v_raw is null or char_length(v_raw) = 0 or char_length(v_raw) > 128 then
    return null;
  end if;
  return encode(extensions.digest(v_raw, 'sha256'), 'hex');
end;
$$;

create function seru24.write_log(
  p_level text, p_channel text, p_event text, p_message text,
  p_context jsonb default null, p_status int default null, p_user uuid default null
) returns void
language plpgsql
set search_path = ''
as $$
begin
  insert into seru24.system_logs
    (user_id, level, channel, event_code, message, context, status_code, ip_address, user_agent, visitor_key_hash)
  values
    (coalesce(p_user, auth.uid()), p_level, p_channel, p_event, p_message, p_context, p_status::smallint,
     seru24.client_ip(), left(seru24.request_header('user-agent'), 500), seru24.visitor_key_hash());
end;
$$;

-- true = masih dalam batas. Jendela tetap (date_bin), penghitung per user per aksi.
create function seru24.rate_limit_ok(p_action text, p_max int, p_window interval) returns boolean
language plpgsql
set search_path = ''
as $$
declare
  v_count int;
begin
  insert into seru24.rate_limits (user_id, action, window_start, count)
  values (auth.uid(), p_action, date_bin(p_window, now(), timestamptz '2000-01-01'), 1)
  on conflict (user_id, action, window_start)
    do update set count = seru24.rate_limits.count + 1
  returning count into v_count;
  return v_count <= p_max;
end;
$$;

create function seru24.require_user() returns uuid
language plpgsql stable
set search_path = ''
as $$
declare
  v_user uuid := auth.uid();
begin
  if v_user is null then
    raise exception 'tidak terautentikasi' using errcode = '28000';
  end if;
  if exists (select 1 from seru24.profiles p where p.id = v_user and p.banned_at is not null) then
    raise exception 'akun tidak aktif' using errcode = '42501';
  end if;
  return v_user;
end;
$$;

create function seru24.device_ok(p_user uuid) returns boolean
language sql stable
set search_path = ''
as $$
  select exists (
    select 1 from seru24.user_devices d
    where d.user_id = p_user
      and d.visitor_key_hash = seru24.visitor_key_hash()
      and d.revoked_at is null
  )
$$;

create function seru24.is_member(p_conversation uuid, p_user uuid) returns boolean
language sql stable
set search_path = ''
as $$
  select exists (
    select 1 from seru24.conversation_members m
    where m.conversation_id = p_conversation and m.user_id = p_user
  )
$$;

create function seru24.peer_of(p_conversation uuid, p_user uuid) returns uuid
language sql stable
set search_path = ''
as $$
  select m.user_id from seru24.conversation_members m
  where m.conversation_id = p_conversation and m.user_id <> p_user
  limit 1
$$;

create function seru24.is_blocked_between(p_a uuid, p_b uuid) returns boolean
language sql stable
set search_path = ''
as $$
  select exists (
    select 1 from seru24.user_blocks b
    where (b.blocker_id = p_a and b.blocked_id = p_b)
       or (b.blocker_id = p_b and b.blocked_id = p_a)
  )
$$;

-- ===========================================================================
-- Trigger: profil dibuat saat akun Supabase Auth terdaftar
-- ===========================================================================

create function seru24.handle_new_user() returns trigger
language plpgsql security definer
set search_path = ''
as $$
begin
  insert into seru24.profiles (id, username, display_name)
  values (new.id,
          lower(new.raw_user_meta_data ->> 'username'),
          coalesce(left(new.raw_user_meta_data ->> 'display_name', 50), ''));
  insert into seru24.user_settings (user_id) values (new.id);
  insert into seru24.user_stats (user_id) values (new.id);
  perform seru24.write_log('info', 'auth', 'register', 'Pendaftaran akun baru', null, null, new.id);
  return new;
end;
$$;

create trigger seru24_on_auth_user_created
  after insert on auth.users
  for each row execute function seru24.handle_new_user();

-- ===========================================================================
-- Realtime Broadcast: pesan dikirim ke channel privat "user:<id>" milik tiap anggota
-- ===========================================================================

create function seru24.broadcast_message() returns trigger
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
    'reply_to', new.reply_to, 'created_at', new.created_at,
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

create trigger messages_broadcast
  after insert or update on seru24.messages
  for each row execute function seru24.broadcast_message();

-- Hanya pemilik yang boleh bergabung ke channel "user:<id>" miliknya.
create policy seru24_user_channel_read on realtime.messages
  for select to authenticated
  using (realtime.topic() = 'user:' || (select auth.uid())::text);

-- ===========================================================================
-- RPC untuk client (schema public, prefix seru24_)
-- ===========================================================================

create function public.seru24_username_available(p_username text) returns boolean
language plpgsql stable security definer
set search_path = ''
as $$
begin
  if p_username is null or p_username !~ '^[a-z0-9_]{3,30}$' then
    return false;
  end if;
  return not exists (select 1 from seru24.profiles p where p.username = p_username::extensions.citext);
end;
$$;

create function public.seru24_me() returns jsonb
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
      'has_keys', exists (select 1 from seru24.key_backups k where k.user_id = v_user),
      'key_version', (select max(k.key_version) from seru24.user_keys k
                      where k.user_id = v_user and k.revoked_at is null))
    from seru24.profiles p where p.id = v_user);
end;
$$;

-- Dipanggil client setelah login (p_after_login = true) dan setiap kali app dibuka.
create function public.seru24_register_device(p_platform text, p_name text, p_after_login boolean default false)
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
    do update set last_seen_at = now(), platform = excluded.platform
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
    perform seru24.write_log('info', 'auth', 'login_success', 'Login berhasil', null, 200);
  end if;

  return jsonb_build_object('is_new', v_is_new, 'trusted', v_device.trusted_at is not null);
end;
$$;

-- Pertama kali: simpan kunci publik versi 1 dan backup kunci privat (terenkripsi di klien).
create function public.seru24_set_initial_keys(
  p_public_key text, p_encrypted_keys text, p_nonce text, p_kdf text, p_kdf_params jsonb
) returns smallint
language plpgsql security definer
set search_path = ''
as $$
declare
  v_user uuid := seru24.require_user();
begin
  if not seru24.device_ok(v_user) then
    raise exception 'perangkat belum terdaftar' using errcode = '42501';
  end if;
  if exists (select 1 from seru24.user_keys k where k.user_id = v_user) then
    raise exception 'kunci sudah ada' using errcode = '23505';
  end if;

  insert into seru24.user_keys (user_id, key_version, public_key) values (v_user, 1, p_public_key);
  insert into seru24.key_backups (user_id, encrypted_keys, nonce, kdf, kdf_params)
  values (v_user, p_encrypted_keys, p_nonce, p_kdf, p_kdf_params);
  update seru24.user_devices set trusted_at = now()
   where user_id = v_user and visitor_key_hash = seru24.visitor_key_hash();
  perform seru24.write_log('notice', 'key', 'key_created', 'Kunci enkripsi dibuat');
  return 1;
end;
$$;

-- null = perangkat belum terdaftar atau terlalu sering diminta.
create function public.seru24_get_key_backup() returns jsonb
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
    from seru24.key_backups k where k.user_id = v_user);
end;
$$;

-- Dipanggil setelah Kode Keamanan Chat berhasil membuka kunci di perangkat ini.
create function public.seru24_trust_device() returns void
language plpgsql security definer
set search_path = ''
as $$
declare
  v_user uuid := seru24.require_user();
begin
  update seru24.user_devices set trusted_at = coalesce(trusted_at, now())
   where user_id = v_user and visitor_key_hash = seru24.visitor_key_hash() and revoked_at is null;
  perform seru24.write_log('notice', 'key', 'key_restored', 'Kunci dipulihkan di perangkat');
end;
$$;

create function public.seru24_get_public_keys(p_user uuid)
returns table (key_version smallint, public_key text, revoked boolean)
language plpgsql stable security definer
set search_path = ''
as $$
begin
  perform seru24.require_user();
  return query
    select k.key_version, k.public_key::text, k.revoked_at is not null
    from seru24.user_keys k where k.user_id = p_user
    order by k.key_version;
end;
$$;

-- Cocok persis, maks 1 hasil; tidak mengembalikan akun dibanned atau yang memblokir pemanggil.
create function public.seru24_search_user(p_username text)
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
      and not exists (select 1 from seru24.user_blocks b where b.blocker_id = p.id and b.blocked_id = v_user)
    limit 1;
end;
$$;

create function public.seru24_start_direct_chat(p_target uuid) returns jsonb
language plpgsql security definer
set search_path = ''
as $$
declare
  v_user uuid := seru24.require_user();
  v_key text;
  v_conversation uuid;
begin
  if p_target is null or p_target = v_user
     or not exists (select 1 from seru24.profiles p where p.id = p_target and p.banned_at is null)
     or seru24.is_blocked_between(v_user, p_target) then
    return jsonb_build_object('ok', false, 'code', 'unavailable');
  end if;

  v_key := least(v_user::text, p_target::text) || ':' || greatest(v_user::text, p_target::text);
  select c.id into v_conversation from seru24.conversations c where c.direct_key = v_key;
  if v_conversation is not null then
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

create function public.seru24_list_conversations()
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
           exists (select 1 from seru24.user_blocks b where b.blocker_id = v_user and b.blocked_id = p.id)
    from seru24.conversation_members m
    join seru24.conversations c on c.id = m.conversation_id
    join seru24.conversation_members pm on pm.conversation_id = c.id and pm.user_id <> v_user
    join seru24.profiles p on p.id = pm.user_id
    where m.user_id = v_user
    order by m.pinned desc, c.last_message_at desc nulls last;
end;
$$;

-- p_after_seq: sinkron pesan baru (urut naik). p_before_seq: muat riwayat (urut turun).
create function public.seru24_get_messages(
  p_conversation_id uuid, p_after_seq bigint default null, p_before_seq bigint default null, p_limit int default 50
)
returns table (
  id uuid, conversation_id uuid, sender_id uuid, seq bigint, client_msg_id uuid, kind text,
  ciphertext text, nonce text, sender_key_version smallint, recipient_key_version smallint,
  reply_to uuid, created_at timestamptz, edited_at timestamptz, deleted_at timestamptz, expires_at timestamptz
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
           m.reply_to, m.created_at, m.edited_at, m.deleted_at, m.expires_at
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

create function public.seru24_send_message(
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
    when exists (select 1 from seru24.profiles p where p.id = v_peer and p.banned_at is not null) then 'unavailable'
    when not exists (select 1 from seru24.user_keys k where k.user_id = v_user
                       and k.key_version = p_sender_key_version and k.revoked_at is null)
      or not exists (select 1 from seru24.user_keys k where k.user_id = v_peer
                       and k.key_version = p_recipient_key_version and k.revoked_at is null) then 'stale_key'
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

create function public.seru24_accept_chat(p_conversation_id uuid) returns boolean
language plpgsql security definer
set search_path = ''
as $$
declare
  v_user uuid := seru24.require_user();
begin
  update seru24.conversations c set status = 'accepted'
   where c.id = p_conversation_id and c.status = 'pending'
     and c.requested_by is distinct from v_user
     and seru24.is_member(c.id, v_user);
  return found;
end;
$$;

create function public.seru24_mark_read(p_conversation_id uuid, p_seq bigint) returns void
language plpgsql security definer
set search_path = ''
as $$
declare
  v_user uuid := seru24.require_user();
  v_seq bigint;
  v_peer uuid;
begin
  update seru24.conversation_members m
     set last_read_seq = greatest(m.last_read_seq,
                                  least(p_seq, (select c.last_seq from seru24.conversations c where c.id = p_conversation_id)))
   where m.conversation_id = p_conversation_id and m.user_id = v_user
  returning m.last_read_seq into v_seq;

  if v_seq is null then
    return;
  end if;

  if (select s.send_read_receipts from seru24.user_settings s where s.user_id = v_user) then
    v_peer := seru24.peer_of(p_conversation_id, v_user);
    perform realtime.send(jsonb_build_object('conversation_id', p_conversation_id, 'user_id', v_user, 'seq', v_seq),
                          'read', 'user:' || v_peer::text, true);
  end if;
end;
$$;

create function public.seru24_delete_message(p_message_id uuid) returns boolean
language plpgsql security definer
set search_path = ''
as $$
declare
  v_user uuid := seru24.require_user();
begin
  update seru24.messages m
     set ciphertext = null, nonce = null, deleted_at = now()
   where m.id = p_message_id and m.sender_id = v_user and m.deleted_at is null;
  return found;
end;
$$;

create function public.seru24_block_user(p_target uuid) returns void
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
  on conflict do nothing;
  if found then
    perform seru24.write_log('info', 'security', 'user_blocked', 'Pengguna diblokir');
  end if;
end;
$$;

create function public.seru24_unblock_user(p_target uuid) returns void
language plpgsql security definer
set search_path = ''
as $$
declare
  v_user uuid := seru24.require_user();
begin
  delete from seru24.user_blocks where blocker_id = v_user and blocked_id = p_target;
end;
$$;

create function public.seru24_report_user(p_target uuid, p_reason text, p_note text default null) returns jsonb
language plpgsql security definer
set search_path = ''
as $$
declare
  v_user uuid := seru24.require_user();
begin
  if p_target is null or p_target = v_user
     or not exists (select 1 from seru24.profiles p where p.id = p_target) then
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

-- ===========================================================================
-- Hak eksekusi: fungsi public.seru24_* hanya untuk user login,
-- kecuali pengecekan username yang dibutuhkan saat daftar.
-- ===========================================================================
do $$
declare
  v_fn record;
begin
  for v_fn in
    select p.oid::regprocedure as signature
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname like 'seru24\_%'
  loop
    execute format('revoke all on function %s from public, anon', v_fn.signature);
    execute format('grant execute on function %s to authenticated', v_fn.signature);
  end loop;
end;
$$;

grant execute on function public.seru24_username_available(text) to anon;

revoke all on all functions in schema seru24 from public, anon, authenticated;

commit;
