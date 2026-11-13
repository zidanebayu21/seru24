-- seru24: hapus SEMUA data uji (akun yang punya profil seru24 dan seluruh isi tabel seru24).
-- Hanya untuk masa uji. Dijalankan MANUAL. Tidak menyentuh schema public maupun akun tanpa profil seru24.

begin;

-- log dikosongkan lebih dulu: TRUNCATE tidak memicu trigger hanya-tambah per baris
truncate seru24.system_logs, seru24.rate_limits, seru24.daily_stats restart identity;

-- akun Supabase milik seru24; profil dan data turunannya ikut terhapus (on delete cascade)
delete from auth.users u where exists (select 1 from seru24.profiles p where p.id = u.id);

-- percakapan tanpa anggota yang tersisa
truncate seru24.conversations cascade;

-- penghapusan akun di atas tercatat trigger lain; kosongkan lagi agar mulai bersih
truncate seru24.system_logs restart identity;

commit;
