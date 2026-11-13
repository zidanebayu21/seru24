-- seru24: edit profil sendiri (nama tampil). Username tidak bisa diubah.
-- Dijalankan MANUAL oleh pemilik proyek, setelah 20261113070000_seru24_password_change_reset.sql.

begin;

create function public.seru24_update_profile(p_display_name text) returns jsonb
language plpgsql security definer
set search_path = ''
as $$
declare
  v_user uuid := seru24.require_user();
  v_name text := btrim(coalesce(p_display_name, ''));
begin
  if char_length(v_name) > 50 then
    raise exception 'nama tampil maksimal 50 karakter' using errcode = '22001';
  end if;
  update seru24.profiles set display_name = v_name where id = v_user;
  perform seru24.write_log('info', 'auth', 'profile_updated', 'Profil diperbarui');
  return jsonb_build_object('display_name', v_name);
end;
$$;

revoke all on function public.seru24_update_profile(text) from public, anon;
grant execute on function public.seru24_update_profile(text) to authenticated;

commit;
