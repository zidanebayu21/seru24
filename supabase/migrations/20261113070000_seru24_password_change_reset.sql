-- seru24: ganti password dan reset password. Hanya service_role (server Nuxt) yang boleh memanggil;
-- server sudah memverifikasi password lama (ganti) atau token pemulihan dari email (reset).
-- Dijalankan MANUAL oleh pemilik proyek, setelah 20261113060000_seru24_login_username.sql.
-- Rincian: doc/keamanan-password-transport.md bagian "Ganti dan reset password".

begin;

-- Ganti password: kunci chat tetap, hanya salt dan backup (dibungkus wrap_key baru) yang diganti.
create function public.seru24_change_auth(
  p_user uuid, p_salt text, p_encrypted_keys text, p_nonce text, p_kdf_params jsonb
) returns void
language plpgsql security definer
set search_path = ''
as $$
begin
  update seru24.profiles set auth_salt = p_salt where id = p_user and deleted_at is null;
  if not found then
    raise exception 'profil tidak ditemukan' using errcode = 'P0002';
  end if;

  update seru24.key_backups
     set encrypted_keys = p_encrypted_keys, nonce = p_nonce, kdf = 'scrypt', kdf_params = p_kdf_params
   where user_id = p_user and deleted_at is null;
  if not found then
    raise exception 'backup kunci tidak ditemukan' using errcode = 'P0002';
  end if;
end;
$$;

-- Reset password: semua kunci lama dicabut, kunci baru (versi berikutnya) dipasang.
-- Pesan lama terenkripsi dengan kunci lama sehingga tidak bisa dibaca lagi.
create function public.seru24_reset_keys(
  p_user uuid, p_version smallint, p_salt text, p_public_key text,
  p_encrypted_keys text, p_nonce text, p_kdf_params jsonb
) returns void
language plpgsql security definer
set search_path = ''
as $$
declare
  v_next smallint;
begin
  select coalesce(max(k.key_version), 0) + 1 into v_next from seru24.user_keys k where k.user_id = p_user;
  if p_version is distinct from v_next then
    raise exception 'versi kunci tidak sesuai (diharapkan %)', v_next using errcode = '40001';
  end if;

  update seru24.profiles set auth_salt = p_salt where id = p_user and deleted_at is null;
  if not found then
    raise exception 'profil tidak ditemukan' using errcode = 'P0002';
  end if;

  update seru24.user_keys set revoked_at = now() where user_id = p_user and revoked_at is null;
  insert into seru24.user_keys (user_id, key_version, public_key) values (p_user, p_version, p_public_key);

  insert into seru24.key_backups (user_id, encrypted_keys, nonce, kdf, kdf_params)
  values (p_user, p_encrypted_keys, p_nonce, 'scrypt', p_kdf_params)
  on conflict (user_id) do update
    set encrypted_keys = excluded.encrypted_keys, nonce = excluded.nonce,
        kdf = excluded.kdf, kdf_params = excluded.kdf_params, deleted_at = null;

  -- semua perangkat harus login ulang dengan password baru
  update seru24.user_devices set trusted_at = null where user_id = p_user;
end;
$$;

revoke all on function public.seru24_change_auth(uuid, text, text, text, jsonb) from public, anon, authenticated;
revoke all on function public.seru24_reset_keys(uuid, smallint, text, text, text, text, jsonb) from public, anon, authenticated;
grant execute on function public.seru24_change_auth(uuid, text, text, text, jsonb) to service_role;
grant execute on function public.seru24_reset_keys(uuid, smallint, text, text, text, text, jsonb) to service_role;

commit;
