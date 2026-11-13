-- seru24: login memakai username selain email.
-- Dijalankan MANUAL oleh pemilik proyek, setelah 20261113050000_seru24_timestamps.sql (memakai kolom deleted_at).
-- Hanya service_role (server Nuxt) yang boleh memanggil; email tidak pernah dikirim ke client.
-- Username tidak ditemukan dijawab server dengan pesan yang sama seperti password salah (OWASP ASVS V2.2).

begin;

create function public.seru24_login_email(p_username text) returns text
language sql stable security definer
set search_path = ''
as $$
  select u.email::text
  from seru24.profiles p
  join auth.users u on u.id = p.id
  where p_username ~ '^[a-z0-9_]{3,30}$'
    and p.username = p_username::extensions.citext
    and p.banned_at is null
    and p.deleted_at is null
  limit 1
$$;

revoke all on function public.seru24_login_email(text) from public, anon, authenticated;
grant execute on function public.seru24_login_email(text) to service_role;

commit;
