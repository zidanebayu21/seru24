-- seru24: log keputusan autentikasi (berhasil dan gagal) dari server, OWASP ASVS V7.2.1.
-- Dijalankan MANUAL oleh pemilik proyek, setelah 20261113030000_seru24_public_usage.sql.
--  - seru24_server_log menerima user dan channel, sehingga login/daftar tercatat di channel 'auth' dengan user_id.
--  - login_success dicatat server (/api/auth/login), bukan lagi oleh RPC register_device yang bergantung pada client.

begin;

drop function public.seru24_server_log(text, text, text, jsonb, int, text, text);

create function public.seru24_server_log(
  p_level text, p_event text, p_message text,
  p_context jsonb default null, p_status int default null,
  p_ip text default null, p_user_agent text default null,
  p_channel text default 'server', p_user uuid default null
) returns void
language plpgsql security definer
set search_path = ''
as $$
declare
  v_ip inet;
begin
  begin
    v_ip := p_ip::inet;
  exception when others then
    v_ip := null;
  end;
  insert into seru24.system_logs
    (user_id, level, channel, event_code, message, context, status_code, ip_address, user_agent)
  values
    ((select p.id from seru24.profiles p where p.id = p_user),
     p_level,
     case when p_channel in ('auth', 'chat', 'key', 'device', 'admin', 'security', 'server') then p_channel else 'server' end,
     left(p_event, 60), left(p_message, 500), p_context, p_status::smallint,
     v_ip, left(p_user_agent, 500));
end;
$$;

revoke all on function public.seru24_server_log(text, text, text, jsonb, int, text, text, text, uuid) from public, anon, authenticated;
grant execute on function public.seru24_server_log(text, text, text, jsonb, int, text, text, text, uuid) to service_role;

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
  end if;

  return jsonb_build_object('is_new', v_is_new, 'trusted', v_device.trusted_at is not null);
end;
$$;

commit;
