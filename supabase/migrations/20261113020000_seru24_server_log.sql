-- seru24: pencatatan error server (Nitro) ke seru24.system_logs.
-- Dijalankan MANUAL oleh pemilik proyek, setelah 20261113010000_seru24_functions.sql.
-- Hanya bisa dipanggil service_role (server); client tidak bisa menulis log palsu (OWASP ASVS V7.1).

begin;

alter table seru24.system_logs drop constraint system_logs_channel_check;
alter table seru24.system_logs add constraint system_logs_channel_check
  check (channel in ('auth', 'chat', 'key', 'device', 'admin', 'security', 'server'));

create function public.seru24_server_log(
  p_level text, p_event text, p_message text,
  p_context jsonb default null, p_status int default null,
  p_ip text default null, p_user_agent text default null
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
  insert into seru24.system_logs (level, channel, event_code, message, context, status_code, ip_address, user_agent)
  values (p_level, 'server', left(p_event, 60), left(p_message, 500), p_context, p_status::smallint,
          v_ip, left(p_user_agent, 500));
end;
$$;

revoke all on function public.seru24_server_log(text, text, text, jsonb, int, text, text) from public, anon, authenticated;
grant execute on function public.seru24_server_log(text, text, text, jsonb, int, text, text) to service_role;

commit;
