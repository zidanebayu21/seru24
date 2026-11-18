-- seru24: rekap statistik harian (daily_stats) + retensi otomatis 1000 data tertua saat ukuran DB >= 400 MB.
-- Dijalankan MANUAL oleh pemilik proyek, setelah 20261113090000_seru24_push_tokens.sql.
-- Dapat dipanggil dari pg_cron (internal Supabase) maupun endpoint server /api/cron/daily-stats (cron eksternal).

begin;

create index if not exists messages_created_idx on seru24.messages (created_at, id);

create or replace function public.seru24_collect_daily_stats_and_prune(
  p_day date default ((now() at time zone 'Asia/Jakarta')::date),
  p_limit_bytes bigint default 419430400,
  p_batch int default 1000
) returns jsonb
language plpgsql security definer
set search_path = ''
as $$
declare
  v_day date := coalesce(p_day, (now() at time zone 'Asia/Jakarta')::date);
  v_start timestamptz := (v_day::timestamp at time zone 'Asia/Jakarta');
  v_end timestamptz := ((v_day + 1)::timestamp at time zone 'Asia/Jakarta');
  v_limit_bytes bigint := greatest(coalesce(p_limit_bytes, 419430400), 1);
  v_batch int := least(greatest(coalesce(p_batch, 1000), 1), 5000);

  v_registrations int := 0;
  v_logins_success int := 0;
  v_logins_failed int := 0;
  v_active_users int := 0;
  v_messages_sent bigint := 0;
  v_messages_rejected bigint := 0;
  v_attachments_sent int := 0;
  v_reports_opened int := 0;

  v_deleted_rate_limits int := 0;
  v_deleted_expired_msgs int := 0;
  v_db_size_before bigint := 0;
  v_db_size_after bigint := 0;
  v_over_limit boolean := false;
  v_pruned_logs int := 0;
  v_pruned_msgs int := 0;

  v_total_users bigint := 0;
  v_total_conversations bigint := 0;
  v_total_messages bigint := 0;
  v_total_logs bigint := 0;
  v_open_reports bigint := 0;
begin
  -- 1. Hitung metrik harian sebelum pemangkasan agar statistik tetap akurat.
  select count(*)::int into v_registrations
  from seru24.profiles
  where created_at >= v_start and created_at < v_end;

  select
    count(*) filter (where channel = 'auth' and event_code = 'login_success')::int,
    count(*) filter (where channel = 'auth' and event_code = 'login_failed')::int,
    count(*) filter (where event_code = 'message_rejected')::bigint
  into v_logins_success, v_logins_failed, v_messages_rejected
  from seru24.system_logs
  where created_at >= v_start and created_at < v_end;

  select count(*)::bigint into v_messages_sent
  from seru24.messages
  where created_at >= v_start and created_at < v_end;

  select count(*)::int into v_attachments_sent
  from seru24.attachments
  where created_at >= v_start and created_at < v_end;

  select count(*)::int into v_reports_opened
  from seru24.reports
  where created_at >= v_start and created_at < v_end;

  select count(distinct uid)::int into v_active_users
  from (
    select m.sender_id as uid
    from seru24.messages m
    where m.sender_id is not null and m.created_at >= v_start and m.created_at < v_end
    union
    select l.user_id as uid
    from seru24.system_logs l
    where l.user_id is not null and l.created_at >= v_start and l.created_at < v_end
  ) active_src;

  insert into seru24.daily_stats (
    day, registrations, logins_success, logins_failed,
    active_users, messages_sent, messages_rejected,
    attachments_sent, reports_opened
  ) values (
    v_day, v_registrations, v_logins_success, v_logins_failed,
    v_active_users, v_messages_sent, v_messages_rejected,
    v_attachments_sent, v_reports_opened
  )
  on conflict (day) do update set
    registrations     = excluded.registrations,
    logins_success    = excluded.logins_success,
    logins_failed     = excluded.logins_failed,
    active_users      = excluded.active_users,
    messages_sent     = excluded.messages_sent,
    messages_rejected = excluded.messages_rejected,
    attachments_sent  = excluded.attachments_sent,
    reports_opened    = excluded.reports_opened;

  -- 2. Bersihkan data kedaluwarsa rutin (rate_limits & pesan berumur).
  delete from seru24.rate_limits
  where window_start < now() - interval '1 day';
  get diagnostics v_deleted_rate_limits = row_count;

  delete from seru24.messages
  where expires_at is not null and expires_at < now();
  get diagnostics v_deleted_expired_msgs = row_count;

  -- 3. Cek ukuran database; bila >= 400 MB, eliminasi 1000 data tertua lintas system_logs & messages.
  v_db_size_before := pg_database_size(current_database());
  v_over_limit := v_db_size_before >= v_limit_bytes;

  if v_over_limit then
    with oldest_candidates as (
      (
        select 'log'::text as kind, l.id::text as row_id, l.created_at
        from seru24.system_logs l
        order by l.created_at asc, l.id asc
        limit v_batch
      )
      union all
      (
        select 'msg'::text as kind, m.id::text as row_id, m.created_at
        from seru24.messages m
        order by m.created_at asc, m.id asc
        limit v_batch
      )
    ),
    picked as (
      select kind, row_id
      from oldest_candidates
      order by created_at asc
      limit v_batch
    ),
    del_logs as (
      delete from seru24.system_logs l
      where l.id in (select (p.row_id)::bigint from picked p where p.kind = 'log')
      returning 1
    ),
    del_msgs as (
      delete from seru24.messages m
      where m.id in (select (p.row_id)::uuid from picked p where p.kind = 'msg')
      returning 1
    )
    select
      coalesce((select count(*)::int from del_logs), 0),
      coalesce((select count(*)::int from del_msgs), 0)
    into v_pruned_logs, v_pruned_msgs;

    if (v_pruned_logs + v_pruned_msgs) > 0 then
      insert into seru24.system_logs (level, channel, event_code, message, context)
      values (
        'info',
        'admin',
        'db_pruned',
        'Eliminasi otomatis data tertua (batas kapasitas 400 MB)',
        jsonb_build_object(
          'db_size_bytes', v_db_size_before,
          'limit_bytes', v_limit_bytes,
          'batch', v_batch,
          'pruned_logs', v_pruned_logs,
          'pruned_messages', v_pruned_msgs
        )
      );
    end if;
  end if;

  v_db_size_after := pg_database_size(current_database());

  select count(*) into v_total_users from seru24.profiles;
  select count(*) into v_total_conversations from seru24.conversations;
  select count(*) into v_total_messages from seru24.messages;
  select count(*) into v_total_logs from seru24.system_logs;
  select count(*) into v_open_reports from seru24.reports where status = 'open';

  return jsonb_build_object(
    'day', v_day,
    'daily', jsonb_build_object(
      'registrations', v_registrations,
      'logins_success', v_logins_success,
      'logins_failed', v_logins_failed,
      'active_users', v_active_users,
      'messages_sent', v_messages_sent,
      'messages_rejected', v_messages_rejected,
      'attachments_sent', v_attachments_sent,
      'reports_opened', v_reports_opened
    ),
    'totals', jsonb_build_object(
      'users', v_total_users,
      'conversations', v_total_conversations,
      'messages', v_total_messages,
      'system_logs', v_total_logs,
      'open_reports', v_open_reports
    ),
    'storage', jsonb_build_object(
      'db_size_bytes', v_db_size_before,
      'db_size_after_bytes', v_db_size_after,
      'db_size_mb', round((v_db_size_before::numeric / 1048576.0), 2),
      'limit_bytes', v_limit_bytes,
      'limit_mb', round((v_limit_bytes::numeric / 1048576.0), 2),
      'over_limit', v_over_limit,
      'pruned', (v_pruned_logs + v_pruned_msgs) > 0,
      'pruned_logs', v_pruned_logs,
      'pruned_messages', v_pruned_msgs,
      'deleted_expired_messages', v_deleted_expired_msgs,
      'deleted_rate_limits', v_deleted_rate_limits
    )
  );
end;
$$;

revoke all on function public.seru24_collect_daily_stats_and_prune(date, bigint, int) from public, anon, authenticated;
grant execute on function public.seru24_collect_daily_stats_and_prune(date, bigint, int) to service_role;

-- Daftarkan pg_cron internal Supabase bila ekstensi tersedia (aman dilewati bila belum diaktifkan).
do $$
declare
  v_job_id bigint;
begin
  select jobid into v_job_id
  from cron.job
  where jobname = 'seru24_daily_stats_and_prune'
  limit 1;

  if v_job_id is not null then
    perform cron.unschedule(v_job_id);
  end if;

  perform cron.schedule(
    'seru24_daily_stats_and_prune',
    '55 0 * * *',
    'select public.seru24_collect_daily_stats_and_prune();'
  );
exception when others then
  null;
end;
$$;

commit;
