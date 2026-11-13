-- seru24: schema, tabel, index, dan RLS dasar (tanpa policy = tolak semua).
-- Sumber rancangan: doc/database.md
-- Dijalankan MANUAL oleh pemilik proyek. Isi: hanya struktur, belum ada fungsi/RPC/trigger/policy.
-- Jangan tambahkan schema "seru24" ke "Exposed schemas" di Dashboard Supabase.

begin;

create extension if not exists citext schema extensions;

create schema if not exists seru24;

-- ---------------------------------------------------------------------------
-- 1. profiles (terlihat pengguna lain lewat RPC)
-- ---------------------------------------------------------------------------
create table seru24.profiles (
  id            uuid primary key references auth.users (id) on delete cascade,
  username      extensions.citext not null unique
                check (char_length(username::text) between 3 and 30 and username::text ~ '^[a-z0-9_]+$'),
  display_name  varchar(50) not null default '',
  avatar_path   varchar(128),
  banned_at     timestamptz,
  created_at    timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- 2. user_settings
-- ---------------------------------------------------------------------------
create table seru24.user_settings (
  user_id             uuid primary key references seru24.profiles (id) on delete cascade,
  send_read_receipts  boolean not null default true,
  show_last_seen      boolean not null default true,
  updated_at          timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- 3. user_keys (kunci publik X25519, 32 byte = 44 karakter base64)
-- ---------------------------------------------------------------------------
create table seru24.user_keys (
  user_id      uuid not null references seru24.profiles (id) on delete cascade,
  key_version  smallint not null check (key_version >= 1),
  public_key   varchar(44) not null check (char_length(public_key) = 44),
  created_at   timestamptz not null default now(),
  revoked_at   timestamptz,
  primary key (user_id, key_version)
);

-- ---------------------------------------------------------------------------
-- 4. key_backups (kunci privat terenkripsi di klien)
-- ---------------------------------------------------------------------------
create table seru24.key_backups (
  user_id         uuid primary key references seru24.profiles (id) on delete cascade,
  encrypted_keys  varchar(4096) not null,
  nonce           varchar(16) not null check (char_length(nonce) = 16),
  kdf             varchar(16) not null check (kdf in ('scrypt', 'argon2id')),
  kdf_params      jsonb not null check (octet_length(kdf_params::text) < 512),
  updated_at      timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- 5. conversations
-- ---------------------------------------------------------------------------
create table seru24.conversations (
  id                       uuid primary key default gen_random_uuid(),
  direct_key               varchar(73) not null unique,
  status                   varchar(8) not null default 'pending'
                           check (status in ('pending', 'accepted')),
  requested_by             uuid references seru24.profiles (id) on delete set null,
  disappear_after_seconds  int check (disappear_after_seconds between 60 and 2592000),
  last_seq                 bigint not null default 0,
  last_message_at          timestamptz,
  created_at               timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- 6. conversation_members (tepat 2 baris per percakapan, dijaga RPC)
-- ---------------------------------------------------------------------------
create table seru24.conversation_members (
  conversation_id  uuid not null references seru24.conversations (id) on delete cascade,
  user_id          uuid not null references seru24.profiles (id) on delete cascade,
  last_read_seq    bigint not null default 0,
  muted            boolean not null default false,
  archived         boolean not null default false,
  pinned           boolean not null default false,
  joined_at        timestamptz not null default now(),
  primary key (conversation_id, user_id)
);
create index conversation_members_user_idx on seru24.conversation_members (user_id);

-- ---------------------------------------------------------------------------
-- 7. attachments (blob terenkripsi di Storage; nama/MIME asli ada di dalam pesan)
-- ---------------------------------------------------------------------------
create table seru24.attachments (
  id               uuid primary key default gen_random_uuid(),
  conversation_id  uuid not null references seru24.conversations (id) on delete cascade,
  uploader_id      uuid references seru24.profiles (id) on delete set null,
  storage_path     varchar(128) not null,
  size_bytes       int not null check (size_bytes between 1 and 10485760),
  created_at       timestamptz not null default now()
);
create index attachments_conversation_idx on seru24.attachments (conversation_id);

-- ---------------------------------------------------------------------------
-- 8. messages
-- ---------------------------------------------------------------------------
create table seru24.messages (
  id                     uuid primary key default gen_random_uuid(),
  conversation_id        uuid not null references seru24.conversations (id) on delete cascade,
  sender_id              uuid references seru24.profiles (id) on delete set null,
  seq                    bigint not null,
  client_msg_id          uuid not null,
  kind                   varchar(8) not null check (kind in ('text', 'image', 'file')),
  ciphertext             text check (char_length(ciphertext) <= 16384),
  nonce                  varchar(16) check (char_length(nonce) = 16),
  sender_key_version     smallint not null check (sender_key_version >= 1),
  recipient_key_version  smallint not null check (recipient_key_version >= 1),
  reply_to               uuid references seru24.messages (id) on delete set null,
  attachment_id          uuid references seru24.attachments (id) on delete set null,
  created_at             timestamptz not null default now(),
  edited_at              timestamptz,
  deleted_at             timestamptz,
  expires_at             timestamptz,
  unique (conversation_id, seq),
  unique (sender_id, client_msg_id),
  -- pesan aktif wajib punya isi terenkripsi dan nonce; pesan dihapus boleh kosong
  check (deleted_at is not null or (ciphertext is not null and nonce is not null)),
  -- media wajib punya lampiran, teks tidak boleh
  check (deleted_at is not null
         or (kind = 'text' and attachment_id is null)
         or (kind in ('image', 'file') and attachment_id is not null))
);
create index messages_expires_idx on seru24.messages (expires_at) where expires_at is not null;

-- ---------------------------------------------------------------------------
-- 9. user_blocks
-- ---------------------------------------------------------------------------
create table seru24.user_blocks (
  blocker_id  uuid not null references seru24.profiles (id) on delete cascade,
  blocked_id  uuid not null references seru24.profiles (id) on delete cascade,
  created_at  timestamptz not null default now(),
  primary key (blocker_id, blocked_id),
  check (blocker_id <> blocked_id)
);
create index user_blocks_blocked_idx on seru24.user_blocks (blocked_id);

-- ---------------------------------------------------------------------------
-- 10. push_tokens
-- ---------------------------------------------------------------------------
create table seru24.push_tokens (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references seru24.profiles (id) on delete cascade,
  platform    varchar(8) not null check (platform in ('android', 'ios', 'web')),
  token       varchar(512) not null unique,
  web_p256dh  varchar(100),
  web_auth    varchar(32),
  updated_at  timestamptz not null default now()
);
create index push_tokens_user_idx on seru24.push_tokens (user_id);

-- ---------------------------------------------------------------------------
-- 11. system_logs (struktur mengikuti system_logs di gaspro; hanya-tambah)
-- ---------------------------------------------------------------------------
create table seru24.system_logs (
  id                bigint generated always as identity primary key,
  user_id           uuid references seru24.profiles (id) on delete set null,
  level             varchar(20) not null
                    check (level in ('info', 'notice', 'warning', 'error', 'critical')),
  channel           varchar(50) not null
                    check (channel in ('auth', 'chat', 'key', 'device', 'admin', 'security')),
  event_code        varchar(60) not null,
  message           varchar(500) not null,
  context           jsonb check (octet_length(context::text) < 2048),
  extra             jsonb check (octet_length(extra::text) < 2048),
  status_code       smallint,
  ip_address        inet,
  user_agent        varchar(500),
  visitor_key_hash  char(64),
  created_at        timestamptz not null default now()
);
create index system_logs_created_idx       on seru24.system_logs (created_at);
create index system_logs_level_idx         on seru24.system_logs (level, created_at);
create index system_logs_channel_idx       on seru24.system_logs (channel, created_at);
create index system_logs_channel_event_idx on seru24.system_logs (channel, event_code);
create index system_logs_user_idx          on seru24.system_logs (user_id, created_at);

-- log tidak boleh diubah; hanya job retensi (DELETE) yang boleh membersihkan
create function seru24.block_log_update() returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception 'system_logs bersifat hanya-tambah';
end;
$$;
create trigger system_logs_no_update
  before update on seru24.system_logs
  for each row execute function seru24.block_log_update();

-- ---------------------------------------------------------------------------
-- 12. user_devices (visitor key; hanya hash sha256 yang disimpan)
-- ---------------------------------------------------------------------------
create table seru24.user_devices (
  id                uuid primary key default gen_random_uuid(),
  user_id           uuid not null references seru24.profiles (id) on delete cascade,
  visitor_key_hash  char(64) not null,
  platform          varchar(8) not null check (platform in ('android', 'ios', 'web')),
  name              varchar(60),
  first_seen_at     timestamptz not null default now(),
  last_seen_at      timestamptz not null default now(),
  trusted_at        timestamptz,
  revoked_at        timestamptz,
  unique (user_id, visitor_key_hash)
);

-- ---------------------------------------------------------------------------
-- 13. user_stats (penghitung per akun, hanya server)
-- ---------------------------------------------------------------------------
create table seru24.user_stats (
  user_id               uuid primary key references seru24.profiles (id) on delete cascade,
  login_count           int not null default 0,
  failed_login_count    int not null default 0,
  last_login_at         timestamptz,
  last_failed_login_at  timestamptz,
  locked_until          timestamptz,
  messages_sent         bigint not null default 0,
  messages_rejected     bigint not null default 0,
  attachments_sent      int not null default 0,
  reports_received      int not null default 0,
  last_active_at        timestamptz
);

-- ---------------------------------------------------------------------------
-- 14. daily_stats (rekap harian, hanya admin)
-- ---------------------------------------------------------------------------
create table seru24.daily_stats (
  day                date primary key,
  registrations      int not null default 0,
  logins_success     int not null default 0,
  logins_failed      int not null default 0,
  active_users       int not null default 0,
  messages_sent      bigint not null default 0,
  messages_rejected  bigint not null default 0,
  attachments_sent   int not null default 0,
  reports_opened     int not null default 0
);

-- ---------------------------------------------------------------------------
-- 15. reports (laporan pengguna; wajib untuk Play Store / App Store)
-- ---------------------------------------------------------------------------
create table seru24.reports (
  id                uuid primary key default gen_random_uuid(),
  reporter_id       uuid references seru24.profiles (id) on delete set null,
  reported_user_id  uuid not null references seru24.profiles (id) on delete cascade,
  reason            varchar(16) not null check (reason in ('spam', 'abuse', 'scam', 'other')),
  note              varchar(500),
  status            varchar(12) not null default 'open'
                    check (status in ('open', 'reviewed', 'dismissed', 'actioned')),
  created_at        timestamptz not null default now(),
  reviewed_at       timestamptz
);
create index reports_status_idx   on seru24.reports (status, created_at);
create index reports_reported_idx on seru24.reports (reported_user_id);

-- ---------------------------------------------------------------------------
-- 16. app_admins (diisi manual lewat SQL oleh pemilik proyek)
-- ---------------------------------------------------------------------------
create table seru24.app_admins (
  user_id     uuid primary key references seru24.profiles (id) on delete cascade,
  role        varchar(12) not null check (role in ('admin', 'moderator')),
  created_at  timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- 17. rate_limits (penghitung pemanggilan RPC; dibersihkan pg_cron)
-- ---------------------------------------------------------------------------
create table seru24.rate_limits (
  user_id       uuid not null references seru24.profiles (id) on delete cascade,
  action        varchar(24) not null,
  window_start  timestamptz not null,
  count         int not null default 0,
  primary key (user_id, action, window_start)
);
create index rate_limits_window_idx on seru24.rate_limits (window_start);

-- ---------------------------------------------------------------------------
-- Keamanan dasar: RLS aktif di semua tabel (tanpa policy = tolak semua),
-- client (anon/authenticated) tidak punya hak apa pun di schema ini.
-- Akses data hanya lewat fungsi security definer di schema public (file migrasi berikutnya).
-- ---------------------------------------------------------------------------
do $$
declare
  t record;
begin
  for t in select tablename from pg_tables where schemaname = 'seru24' loop
    execute format('alter table seru24.%I enable row level security', t.tablename);
  end loop;
end;
$$;

revoke all on schema seru24 from public, anon, authenticated;
revoke all on all tables    in schema seru24 from public, anon, authenticated;
revoke all on all sequences in schema seru24 from public, anon, authenticated;
revoke all on all functions in schema seru24 from public, anon, authenticated;

alter default privileges in schema seru24 revoke all on tables    from public, anon, authenticated;
alter default privileges in schema seru24 revoke all on sequences from public, anon, authenticated;
alter default privileges in schema seru24 revoke all on functions from public, anon, authenticated;

-- service_role hanya dipakai server (Nitro), tidak pernah di client
grant usage on schema seru24 to service_role;
grant all on all tables    in schema seru24 to service_role;
grant all on all sequences in schema seru24 to service_role;

commit;
