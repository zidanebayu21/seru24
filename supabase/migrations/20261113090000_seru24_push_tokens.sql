-- seru24: registrasi dan pengiriman target token push (FCM / APNs).
-- Dijalankan MANUAL oleh pemilik proyek, setelah 20261113080000_seru24_update_profile.sql.

begin;

-- Daftarkan atau perbarui token push perangkat milik pengguna yang sedang login.
create function public.seru24_register_push_token(p_platform text, p_token text) returns void
language plpgsql security definer
set search_path = ''
as $$
declare
  v_user uuid := seru24.require_user();
  v_token text := btrim(coalesce(p_token, ''));
begin
  if not seru24.device_ok(v_user) then
    raise exception 'perangkat belum terdaftar' using errcode = '42501';
  end if;
  if p_platform not in ('android', 'ios') or char_length(v_token) < 10 or char_length(v_token) > 512 then
    raise exception 'token push tidak valid' using errcode = '22023';
  end if;

  insert into seru24.push_tokens (user_id, platform, token, deleted_at)
  values (v_user, p_platform, v_token, null)
  on conflict (token) do update
    set user_id = excluded.user_id,
        platform = excluded.platform,
        deleted_at = null,
        updated_at = now();
end;
$$;

-- Hapus token push perangkat saat notifikasi dimatikan atau pengguna logout.
create function public.seru24_unregister_push_token(p_token text) returns void
language plpgsql security definer
set search_path = ''
as $$
declare
  v_user uuid := seru24.require_user();
  v_token text := btrim(coalesce(p_token, ''));
begin
  if v_token = '' then
    return;
  end if;
  delete from seru24.push_tokens where user_id = v_user and token = v_token;
end;
$$;

-- Ambil daftar token penerima untuk satu pesan baru; hanya boleh dipanggil service_role (server Nuxt).
create function public.seru24_push_targets_for_message(
  p_sender uuid, p_conversation_id uuid, p_message_id uuid
) returns table (token text, platform text)
language plpgsql stable security definer
set search_path = ''
as $$
declare
  v_peer uuid;
begin
  if p_sender is null or p_conversation_id is null or p_message_id is null then
    return;
  end if;
  if not seru24.is_member(p_conversation_id, p_sender) then
    return;
  end if;
  if not exists (
    select 1 from seru24.messages msg
    where msg.id = p_message_id
      and msg.conversation_id = p_conversation_id
      and msg.sender_id = p_sender
      and msg.deleted_at is null
      and msg.created_at > now() - interval '5 minutes'
  ) then
    return;
  end if;

  v_peer := seru24.peer_of(p_conversation_id, p_sender);
  if v_peer is null
     or not exists (select 1 from seru24.profiles p where p.id = v_peer and p.banned_at is null)
     or seru24.is_blocked_between(p_sender, v_peer)
     or exists (select 1 from seru24.conversation_members cm
                where cm.conversation_id = p_conversation_id and cm.user_id = v_peer and cm.muted) then
    return;
  end if;

  return query
    select pt.token::text, pt.platform::text
    from seru24.push_tokens pt
    where pt.user_id = v_peer
      and pt.deleted_at is null
      and pt.platform in ('android', 'ios');
end;
$$;

-- Bersihkan token usang/tidak terdaftar yang ditolak oleh FCM.
create function public.seru24_prune_push_tokens(p_tokens text[]) returns int
language plpgsql security definer
set search_path = ''
as $$
declare
  v_count int;
begin
  if p_tokens is null or array_length(p_tokens, 1) is null then
    return 0;
  end if;
  delete from seru24.push_tokens where token = any(p_tokens);
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

revoke all on function public.seru24_register_push_token(text, text) from public, anon;
grant execute on function public.seru24_register_push_token(text, text) to authenticated;

revoke all on function public.seru24_unregister_push_token(text) from public, anon;
grant execute on function public.seru24_unregister_push_token(text) to authenticated;

revoke all on function public.seru24_push_targets_for_message(uuid, uuid, uuid) from public, anon, authenticated;
grant execute on function public.seru24_push_targets_for_message(uuid, uuid, uuid) to service_role;

revoke all on function public.seru24_prune_push_tokens(text[]) from public, anon, authenticated;
grant execute on function public.seru24_prune_push_tokens(text[]) to service_role;

commit;
