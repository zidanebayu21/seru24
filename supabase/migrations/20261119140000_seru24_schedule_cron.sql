-- Daftarkan pengirim pesan terjadwal ke pg_cron. Migrasi sebelumnya (20261119130000) mendaftarkannya dalam blok yang
-- menelan semua error, sehingga bila ekstensi pg_cron belum aktif, penjadwalan gagal tanpa kabar. Di sini error sengaja
-- tidak ditelan: bila gagal, pesan error langsung terlihat.
-- Prasyarat: ekstensi pg_cron aktif (Dashboard Supabase > Database > Extensions > pg_cron), atau baris pertama di bawah.

create extension if not exists pg_cron;

select cron.unschedule(jobid) from cron.job where jobname = 'seru24_dispatch_scheduled';

select cron.schedule('seru24_dispatch_scheduled', '* * * * *', 'select seru24.dispatch_scheduled_messages();');

-- pemeriksaan: harus ada 1 baris dengan active = true
select jobid, jobname, schedule, active from cron.job where jobname = 'seru24_dispatch_scheduled';
