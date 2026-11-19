-- Ringkasan pemakaian sejak awal siklus tagihan, untuk email cron (kuota Supabase Free: MAU dan pesan Realtime).
-- Hanya angka agregat; tidak ada isi pesan atau data pribadi. Dipanggil server dengan service role.
-- Rujukan: OWASP ASVS V8.3 (data sensitif tidak diekspos), V4.1 (akses hanya untuk peran yang berhak).

begin;

create or replace function public.seru24_usage_overview(p_from timestamptz)
returns jsonb
language sql stable security definer
set search_path = ''
as $$
  select jsonb_build_object(
    -- pengguna yang aktif di aplikasi sejak awal siklus (perkiraan MAU Supabase)
    'mau',              (select count(*) from seru24.user_stats s where s.last_active_at >= p_from),
    'messages_created', (select count(*) from seru24.messages m where m.created_at >= p_from),
    'messages_deleted', (select count(*) from seru24.messages m where m.deleted_at >= p_from),
    'devices_active',   (select count(*) from seru24.user_devices d where d.last_seen_at >= p_from and d.deleted_at is null)
  );
$$;

revoke all on function public.seru24_usage_overview(timestamptz) from public, anon, authenticated;
grant execute on function public.seru24_usage_overview(timestamptz) to service_role;

commit;
