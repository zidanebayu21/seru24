package id.seru24.chat;

import android.content.Intent;
import android.net.Uri;
import android.provider.Settings;

import androidx.core.content.FileProvider;

import com.facebook.react.bridge.Arguments;
import com.facebook.react.bridge.Promise;
import com.facebook.react.bridge.ReactApplicationContext;
import com.facebook.react.bridge.ReactContextBaseJavaModule;
import com.facebook.react.bridge.ReactMethod;
import com.facebook.react.bridge.WritableMap;
import com.facebook.react.modules.core.DeviceEventManagerModule;

import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.security.MessageDigest;
import java.util.Locale;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * Pembaruan dari dalam aplikasi: unduh APK rilis dari Google Drive (HTTPS), cocokkan SHA-256 dengan
 * /api/app/latest, lalu buka layar instal Android. Android tetap meminta persetujuan pengguna dan menolak
 * APK dengan kunci tanda tangan berbeda (OWASP ASVS V10.3.2, V12.4.1).
 */
public class UpdateModule extends ReactContextBaseJavaModule {
    private static final String ALLOWED_HOST = "drive.usercontent.google.com";
    private static final String EVENT_PROGRESS = "seru24UpdateProgress";
    private static final long MAX_BYTES = 100L * 1024 * 1024;
    private static final ExecutorService EXECUTOR = Executors.newSingleThreadExecutor();

    UpdateModule(ReactApplicationContext context) {
        super(context);
    }

    @Override
    public String getName() {
        return "Seru24Update";
    }

    /** Izin "Instal aplikasi tak dikenal" untuk seru24 (wajib sejak Android 8). */
    @ReactMethod
    public void canInstall(Promise promise) {
        promise.resolve(getReactApplicationContext().getPackageManager().canRequestPackageInstalls());
    }

    @ReactMethod
    public void openInstallSettings(Promise promise) {
        ReactApplicationContext ctx = getReactApplicationContext();
        Intent intent = new Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:" + ctx.getPackageName()))
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        ctx.startActivity(intent);
        promise.resolve(null);
    }

    @ReactMethod
    public void downloadAndInstall(String url, String sha256, Promise promise) {
        EXECUTOR.execute(() -> {
            File apk = null;
            try {
                URL source = new URL(url);
                if (!"https".equals(source.getProtocol()) || !ALLOWED_HOST.equals(source.getHost())) {
                    promise.reject("bad_url", "Sumber pembaruan tidak diizinkan");
                    return;
                }
                ReactApplicationContext ctx = getReactApplicationContext();
                File dir = new File(ctx.getCacheDir(), "updates");
                if (!dir.isDirectory() && !dir.mkdirs()) throw new IllegalStateException("Folder unduhan gagal dibuat");
                apk = new File(dir, "seru24-update.apk");

                String actual = download(source, apk);
                if (!actual.equals(sha256.toLowerCase(Locale.ROOT))) {
                    apk.delete();
                    promise.reject("hash_mismatch", "File pembaruan tidak cocok, unduhan dibatalkan");
                    return;
                }

                Uri uri = FileProvider.getUriForFile(ctx, ctx.getPackageName() + ".updates", apk);
                Intent install = new Intent(Intent.ACTION_VIEW)
                    .setDataAndType(uri, "application/vnd.android.package-archive")
                    .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_ACTIVITY_NEW_TASK);
                ctx.startActivity(install);
                promise.resolve(null);
            } catch (Exception e) {
                if (apk != null) apk.delete();
                promise.reject("update_error", e);
            }
        });
    }

    /** Unduh ke file sambil menghitung SHA-256; mengembalikan hash hex. */
    private String download(URL source, File target) throws Exception {
        HttpURLConnection conn = (HttpURLConnection) source.openConnection();
        conn.setConnectTimeout(15_000);
        conn.setReadTimeout(30_000);
        conn.setInstanceFollowRedirects(true);
        try {
            if (conn.getResponseCode() != HttpURLConnection.HTTP_OK || !"https".equals(conn.getURL().getProtocol())) {
                throw new IllegalStateException("Unduhan gagal (" + conn.getResponseCode() + ")");
            }
            long total = conn.getContentLengthLong();
            MessageDigest digest = MessageDigest.getInstance("SHA-256");
            long done = 0;
            long lastEmit = 0;
            try (InputStream in = conn.getInputStream(); OutputStream out = new FileOutputStream(target)) {
                byte[] buffer = new byte[64 * 1024];
                int read;
                while ((read = in.read(buffer)) != -1) {
                    done += read;
                    if (done > MAX_BYTES) throw new IllegalStateException("File pembaruan terlalu besar");
                    digest.update(buffer, 0, read);
                    out.write(buffer, 0, read);
                    if (done - lastEmit >= 256 * 1024) {
                        lastEmit = done;
                        emitProgress(done, total);
                    }
                }
            }
            emitProgress(done, total);
            StringBuilder hex = new StringBuilder();
            for (byte b : digest.digest()) hex.append(String.format(Locale.ROOT, "%02x", b));
            return hex.toString();
        } finally {
            conn.disconnect();
        }
    }

    private void emitProgress(long done, long total) {
        WritableMap map = Arguments.createMap();
        map.putDouble("done", (double) done);
        map.putDouble("total", (double) total);
        getReactApplicationContext()
            .getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter.class)
            .emit(EVENT_PROGRESS, map);
    }
}
