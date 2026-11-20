package id.seru24.chat.rust;

import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import android.provider.Settings;

import androidx.core.content.FileProvider;

import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.security.MessageDigest;
import java.util.Locale;

/**
 * Pembaruan APK dari dalam aplikasi: unduh HTTPS dari Google Drive, verifikasi SHA-256,
 * lalu buka pemasang sistem Android melalui FileProvider.
 */
final class Seru24Updater {
    private static final String ALLOWED_HOST = "drive.usercontent.google.com";
    private static final String APK_NAME = "seru24-update.apk";
    private static final long MAX_BYTES = 100L * 1024 * 1024;

    private Seru24Updater() {}

    static void cleanupUpdates(Context context) {
        File dir = new File(context.getCacheDir(), "updates");
        File[] files = dir.listFiles();
        if (files == null) return;
        for (File f : files) f.delete();
    }

    static String downloadAndInstall(Context context, String urlStr, String sha256) {
        if (!context.getPackageManager().canRequestPackageInstalls()) {
            // Android 8+: pasang dari aplikasi ini butuh izin "Pasang aplikasi tidak dikenal" yang hanya bisa diberikan di Pengaturan.
            Intent settings = new Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:" + context.getPackageName()))
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            context.startActivity(settings);
            return "Izinkan 'Pasang aplikasi tidak dikenal' untuk seru24 di Pengaturan, lalu coba perbarui lagi";
        }
        File apk = null;
        try {
            URL source = new URL(urlStr);
            if (!"https".equals(source.getProtocol()) || !ALLOWED_HOST.equals(source.getHost())) {
                return "Sumber pembaruan tidak diizinkan";
            }
            File dir = new File(context.getCacheDir(), "updates");
            if (!dir.isDirectory() && !dir.mkdirs()) return "Folder unduhan gagal dibuat";
            apk = new File(dir, APK_NAME);
            String expected = sha256.toLowerCase(Locale.ROOT);
            if (!apk.isFile() || !expected.equals(sha256File(apk))) {
                String actual = download(source, apk);
                if (!actual.equals(expected)) {
                    apk.delete();
                    return "File pembaruan tidak cocok, unduhan dibatalkan";
                }
            }
            Uri uri = FileProvider.getUriForFile(context, context.getPackageName() + ".updates", apk);
            Intent install = new Intent(Intent.ACTION_VIEW)
                .setDataAndType(uri, "application/vnd.android.package-archive")
                .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_ACTIVITY_NEW_TASK);
            context.startActivity(install);
            return "";
        } catch (Exception e) {
            if (apk != null) apk.delete();
            return e.getMessage() == null ? "Gagal mengunduh pembaruan" : e.getMessage();
        }
    }

    private static String download(URL url, File dest) throws Exception {
        HttpURLConnection conn = (HttpURLConnection) url.openConnection();
        conn.setConnectTimeout(15_000);
        conn.setReadTimeout(60_000);
        try {
            if (conn.getResponseCode() != 200) {
                throw new IllegalStateException("Unduhan gagal (" + conn.getResponseCode() + ")");
            }
            MessageDigest md = MessageDigest.getInstance("SHA-256");
            long done = 0;
            try (InputStream in = conn.getInputStream(); OutputStream out = new FileOutputStream(dest)) {
                byte[] buf = new byte[16 * 1024];
                int n;
                while ((n = in.read(buf)) != -1) {
                    done += n;
                    if (done > MAX_BYTES) throw new IllegalStateException("File terlalu besar");
                    md.update(buf, 0, n);
                    out.write(buf, 0, n);
                }
            }
            return toHex(md.digest());
        } finally {
            conn.disconnect();
        }
    }

    private static String sha256File(File f) throws Exception {
        MessageDigest md = MessageDigest.getInstance("SHA-256");
        try (InputStream in = new FileInputStream(f)) {
            byte[] buf = new byte[16 * 1024];
            int n;
            while ((n = in.read(buf)) != -1) md.update(buf, 0, n);
        }
        return toHex(md.digest());
    }

    private static String toHex(byte[] bytes) {
        StringBuilder sb = new StringBuilder(bytes.length * 2);
        for (byte b : bytes) sb.append(Character.forDigit((b >> 4) & 0xF, 16)).append(Character.forDigit(b & 0xF, 16));
        return sb.toString();
    }
}
