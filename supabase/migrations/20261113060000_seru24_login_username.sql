-- seru24: satu password (diturunkan di browser) + login dengan email atau username.
-- Dijalankan MANUAL oleh pemilik proyek, setelah 20261113050000_seru24_timestamps.sql (memakai kolom deleted_at).
-- Rincian: doc/keamanan-password-transport.md
--
--  - profiles.auth_salt : salt acak per akun (base64 16 byte) untuk scrypt di browser. Bukan rahasia.
--  - seru24_login_lookup : email + salt dari email/username, hanya untuk service_role (server Nuxt);
--    email tidak pernah dikirim ke client, dan akun tak terdaftar dijawab server dengan salt palsu.

begin;

alter table seru24.profiles
  add column auth_salt varchar(24) check (auth_salt is null or auth_salt ~ '^[A-Za-z0-9+/]{22}==$');

create or replace function seru24.handle_new_user() returns trigger
language plpgsql security definer
set search_path = ''
as $$
begin
  insert into seru24.profiles (id, username, display_name, auth_salt)
  values (new.id,
          lower(new.raw_user_meta_data ->> 'username'),
          coalesce(left(new.raw_user_meta_data ->> 'display_name', 50), ''),
          new.raw_user_meta_data ->> 'auth_salt');
  insert into seru24.user_settings (user_id) values (new.id);
  insert into seru24.user_stats (user_id) values (new.id);
  perform seru24.write_log('info', 'auth', 'register', 'Pendaftaran akun baru', null, null, new.id);
  return new;
end;
$$;

create function public.seru24_login_lookup(p_identifier text) returns jsonb
language sql stable security definer
set search_path = ''
as $$
  select jsonb_build_object('email', u.email, 'salt', p.auth_salt)
  from seru24.profiles p
  join auth.users u on u.id = p.id
  where p.banned_at is null
    and p.deleted_at is null
    and p.auth_salt is not null
    and (
      (position('@' in p_identifier) > 0 and lower(u.email) = lower(p_identifier))
      or (p_identifier ~ '^[a-z0-9_]{3,30}$' and p.username = p_identifier::extensions.citext)
    )
  limit 1
$$;

revoke all on function public.seru24_login_lookup(text) from public, anon, authenticated;
grant execute on function public.seru24_login_lookup(text) to service_role;

commit;
