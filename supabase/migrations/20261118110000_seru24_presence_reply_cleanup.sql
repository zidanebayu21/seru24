-- seru24: status mengetik/online per percakapan (Realtime presence + broadcast di channel privat "conv:<id>"),
-- status baca lawan untuk centang dua, serta pembersihan dokumen yatim dan rekap pemakaian dokumen untuk cron.
-- Dijalankan MANUAL oleh pemilik proyek, setelah 20261118100000_seru24_drive_files.sql.

begin;

-- 1. Channel "conv:<conversation_id>": hanya anggota percakapan yang boleh bergabung, melihat presence,
--    dan mengirim broadcast "typing" (OWASP ASVS V4.1.3). Isi pesan tidak pernah lewat channel ini.
create function public.seru24_can_use_conversation_topic(p_topic text)
returns boolean
language plpgsql stable security definer
set search_path = ''
as $$
declare
  v_id uuid;
begin
  if p_topic is null or p_topic !~ '^conv:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    return false;
  end if;
  v_id := substring(p_topic from 6)::uuid;
  return seru24.is_member(v_id, (select auth.uid()));
end;
$$;
revoke all on function public.seru24_can_use_conversation_topic(text) from public, anon;
grant execute on function public.seru24_can_use_conversation_topic(text) to authenticated;

create policy seru24_conv_channel_read on realtime.messages
  for select to authenticated
  using (realtime.messages.extension in ('broadcast', 'presence')
         and public.seru24_can_use_conversation_topic(realtime.topic()));

create policy seru24_conv_channel_write on realtime.messages
  for insert to authenticated
  with check (realtime.messages.extension in ('broadcast', 'presence')
              and public.seru24_can_use_conversation_topic(realtime.topic()));

-- 2. seq terakhir yang sudah dibaca lawan bicara (centang dua tetap benar setelah halaman dimuat ulang).
create function public.seru24_peer_read_seq(p_conversation_id uuid)
returns bigint
language plpgsql stable security definer
set search_path = ''
as $$
declare
  v_user uuid := seru24.require_user();
begin
  if not seru24.is_member(p_conversation_id, v_user) then
    return 0;
  end if;
  return coalesce((select max(m.last_read_seq) from seru24.conversation_members m
                    where m.conversation_id = p_conversation_id and m.user_id <> v_user), 0);
end;
$$;
revoke all on function public.seru24_peer_read_seq(uuid) from public, anon;
grant execute on function public.seru24_peer_read_seq(uuid) to authenticated;

-- 3. Dokumen yatim (khusus server/cron): upload terputus lebih dari 1 hari, atau file selesai diunggah
--    tetapi tidak dipakai pesan aktif mana pun (pesan gagal terkirim, dihapus, atau kedaluwarsa).
create function public.seru24_file_cleanup_candidates(p_limit int default 200)
returns table (id uuid, drive_file_id text)
language sql stable security definer
set search_path = ''
as $$
  select a.id, a.drive_file_id
  from seru24.attachments a
  where a.created_at < now() - interval '1 day'
    and (a.status = 'uploading'
         or (a.status = 'ready'
             and not exists (select 1 from seru24.messages m
                              where m.attachment_id = a.id and m.deleted_at is null
                                and (m.expires_at is null or m.expires_at > now()))))
  order by a.created_at
  limit least(greatest(coalesce(p_limit, 200), 1), 1000)
$$;

create function public.seru24_file_mark_cleaned(p_ids uuid[])
returns int
language plpgsql security definer
set search_path = ''
as $$
declare
  v_count int;
begin
  update seru24.attachments a
     set status = 'deleted', deleted_at = now(), upload_session = null
   where a.id = any(p_ids) and a.status <> 'deleted';
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

-- Rekap dokumen yang tersimpan (status ready) untuk email laporan.
create function public.seru24_file_usage()
returns jsonb
language sql stable security definer
set search_path = ''
as $$
  select jsonb_build_object('files', count(*), 'bytes', coalesce(sum(a.size_bytes), 0))
  from seru24.attachments a
  where a.status = 'ready'
$$;

do $$
declare
  v_sig text;
begin
  foreach v_sig in array array[
    'public.seru24_file_cleanup_candidates(int)',
    'public.seru24_file_mark_cleaned(uuid[])',
    'public.seru24_file_usage()'
  ] loop
    execute format('revoke all on function %s from public, anon, authenticated', v_sig);
    execute format('grant execute on function %s to service_role', v_sig);
  end loop;
end;
$$;

commit;
