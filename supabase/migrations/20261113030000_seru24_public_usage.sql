-- seru24: kembalikan hak USAGE schema public agar RPC public.seru24_* bisa dipanggil lewat API.
-- USAGE hanya mengizinkan melihat nama objek; akses tabel/fungsi tetap diatur per objek.
-- Sebelum dijalankan sudah dicek: tidak ada tabel atau fungsi lain di public yang bisa diakses anon/authenticated.

begin;

grant usage on schema public to anon, authenticated, service_role;

commit;
