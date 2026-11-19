-- Daftar percakapan per halaman: p_limit/p_offset untuk "muat lebih banyak", p_id untuk satu percakapan.
-- Tanpa argumen tetap berfungsi (klien lama), dibatasi 500 baris. Urutan memakai c.id sebagai penentu akhir
-- agar offset stabil saat last_message_at sama. Fungsi lama tanpa argumen dihapus dulu supaya panggilan tanpa
-- argumen tidak ambigu di PostgREST.
-- Rujukan: OWASP ASVS V11.1.4 (batas sumber daya per permintaan).

begin;

drop function if exists public.seru24_list_conversations();

create function public.seru24_list_conversations(
  p_limit int default null,
  p_offset int default 0,
  p_id uuid default null
)
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
           exists (select 1 from seru24.user_blocks b
                   where b.blocker_id = v_user and b.blocked_id = p.id and b.deleted_at is null)
    from seru24.conversation_members m
    join seru24.conversations c on c.id = m.conversation_id and c.deleted_at is null
    join seru24.conversation_members pm on pm.conversation_id = c.id and pm.user_id <> v_user
    join seru24.profiles p on p.id = pm.user_id
    where m.user_id = v_user and m.deleted_at is null
      and (p_id is null or c.id = p_id)
    order by m.pinned desc, c.last_message_at desc nulls last, c.id
    limit least(coalesce(p_limit, 500), 500)
    offset greatest(coalesce(p_offset, 0), 0);
end;
$$;

revoke all on function public.seru24_list_conversations(int, int, uuid) from public, anon;
grant execute on function public.seru24_list_conversations(int, int, uuid) to authenticated;

commit;
