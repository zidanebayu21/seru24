package id.seru24.chat;

import android.app.Activity;
import android.content.ContentResolver;
import android.content.ContentValues;
import android.content.Context;
import android.content.SharedPreferences;
import android.content.Intent;
import android.database.Cursor;
import android.net.Uri;
import android.os.Environment;
import android.provider.MediaStore;
import android.provider.OpenableColumns;
import android.util.Base64;

import com.facebook.react.bridge.ActivityEventListener;
import com.facebook.react.bridge.Arguments;
import com.facebook.react.bridge.BaseActivityEventListener;
import com.facebook.react.bridge.Promise;
import com.facebook.react.bridge.ReactApplicationContext;
import com.facebook.react.bridge.ReactContextBaseJavaModule;
import com.facebook.react.bridge.ReactMethod;
import com.facebook.react.bridge.WritableArray;
import com.facebook.react.bridge.WritableMap;
import com.facebook.react.modules.core.DeviceEventManagerModule;

import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.security.SecureRandom;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;
import javax.crypto.spec.SecretKeySpec;

/**
 * Dokumen chat di Android, setara web (app/utils/files.ts): file dienkripsi AES-256-GCM dengan kunci acak per file,
 * diunggah/diunduh per potongan 3 MiB lewat /api/files, dan hasil unduhan disimpan ke Download/seru24 setelah tag
 * GCM terverifikasi (file rusak atau kunci salah tidak pernah tersimpan). Kunci file hanya dikirim di pesan E2EE.
 */
public class FileModule extends ReactContextBaseJavaModule {
    private static final int PICK_REQUEST = 4243;
    private static final int CHUNK_BYTES = 3 * 1024 * 1024; // sama dengan FILE_CHUNK_BYTES di web/shared/file-core.ts
    private static final int TAG_BITS = 128;
    private static final int RETRIES = 3;
    private static final String EVENT_PROGRESS = "seru24FileProgress";
    private static final ExecutorService EXECUTOR = Executors.newSingleThreadExecutor();

    private Promise pickPromise;

    private final ActivityEventListener activityListener = new BaseActivityEventListener() {
        @Override
        public void onActivityResult(Activity activity, int requestCode, int resultCode, Intent data) {
            if (requestCode != PICK_REQUEST || pickPromise == null) return;
            Promise promise = pickPromise;
            pickPromise = null;
            WritableArray files = Arguments.createArray();
            if (resultCode == Activity.RESULT_OK && data != null) {
                if (data.getClipData() != null) {
                    for (int i = 0; i < data.getClipData().getItemCount(); i++) {
                        files.pushMap(describe(data.getClipData().getItemAt(i).getUri()));
                    }
                } else if (data.getData() != null) {
                    files.pushMap(describe(data.getData()));
                }
            }
            promise.resolve(files);
        }
    };

    FileModule(ReactApplicationContext context) {
        super(context);
        context.addActivityEventListener(activityListener);
    }

    @Override
    public String getName() {
        return "Seru24Files";
    }

    /** Pemilih dokumen sistem (boleh lebih dari satu); tidak butuh izin penyimpanan. */
    @ReactMethod
    public void pickFiles(Promise promise) {
        Activity activity = getCurrentActivity();
        if (activity == null) {
            promise.reject("no_activity", "Aplikasi belum siap");
            return;
        }
        pickPromise = promise;
        Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT)
            .addCategory(Intent.CATEGORY_OPENABLE)
            .setType("*/*")
            .putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true);
        activity.startActivityForResult(intent, PICK_REQUEST);
    }

    /**
     * Enkripsi file lalu unggah per potongan ke /api/files/{id}/chunk (sesi sudah dibuat lewat /api/files/start).
     * Hasil: kunci dan nonce file (base64) untuk isi pesan E2EE.
     */
    @ReactMethod
    public void encryptAndUpload(String uri, String id, String apiBase, String token, Promise promise) {
        EXECUTOR.execute(() -> {
            try {
                ContentResolver resolver = getReactApplicationContext().getContentResolver();
                SecretKey key = newKey();
                byte[] iv = new byte[12];
                new SecureRandom().nextBytes(iv);
                Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
                cipher.init(Cipher.ENCRYPT_MODE, key, new GCMParameterSpec(TAG_BITS, iv));

                long total = sizeOf(Uri.parse(uri)) + TAG_BITS / 8;
                ChunkUploader uploader = new ChunkUploader(total, id, apiBase, token);
                try (InputStream in = resolver.openInputStream(Uri.parse(uri))) {
                    if (in == null) throw new IllegalStateException("File tidak bisa dibaca");
                    byte[] buffer = new byte[256 * 1024];
                    int read;
                    while ((read = in.read(buffer)) != -1) uploader.feed(cipher.update(buffer, 0, read));
                }
                uploader.feed(cipher.doFinal());
                uploader.finish();

                WritableMap result = Arguments.createMap();
                result.putString("key", Base64.encodeToString(key.getEncoded(), Base64.NO_WRAP));
                result.putString("iv", Base64.encodeToString(iv, Base64.NO_WRAP));
                promise.resolve(result);
            } catch (Exception e) {
                promise.reject("upload_error", e.getMessage(), e);
            }
        });
    }

    /** Unduh per potongan, verifikasi dan dekripsi, lalu simpan ke Download/seru24. Hasil: content URI file. */
    @ReactMethod
    public void downloadAndSave(String id, String apiBase, String token, String keyB64, String ivB64,
                                String name, String mime, double sizeBytes, Promise promise) {
        EXECUTOR.execute(() -> {
            Uri saved = null;
            ContentResolver resolver = getReactApplicationContext().getContentResolver();
            try {
                List<byte[]> plain = fetchAndDecrypt(id, apiBase, token, keyB64, ivB64, sizeBytes);

                ContentValues values = new ContentValues();
                values.put(MediaStore.Downloads.DISPLAY_NAME, name);
                values.put(MediaStore.Downloads.MIME_TYPE, mime.isEmpty() ? "application/octet-stream" : mime);
                values.put(MediaStore.Downloads.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS + "/seru24");
                values.put(MediaStore.Downloads.IS_PENDING, 1);
                saved = resolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values);
                if (saved == null) throw new IllegalStateException("Folder Download tidak bisa ditulis");
                try (OutputStream out = resolver.openOutputStream(saved)) {
                    if (out == null) throw new IllegalStateException("File tidak bisa ditulis");
                    for (byte[] piece : plain) out.write(piece);
                }
                values.clear();
                values.put(MediaStore.Downloads.IS_PENDING, 0);
                resolver.update(saved, values, null, null);
                downloads().edit().putString(id, saved.toString()).apply();
                promise.resolve(saved.toString());
            } catch (Exception e) {
                if (saved != null) resolver.delete(saved, null, null);
                promise.reject("download_error", e.getMessage(), e);
            }
        });
    }

    /**
     * Unduh per potongan lalu dekripsi. Potongan hasil dekripsi disimpan apa adanya (tanpa salinan ulang) dan baru
     * dipakai setelah doFinal memeriksa tag GCM: file yang diubah atau kunci salah gagal di sini dan tidak disimpan.
     */
    private List<byte[]> fetchAndDecrypt(String id, String apiBase, String token, String keyB64, String ivB64,
                                         double sizeBytes) throws Exception {
        long total = (long) sizeBytes + TAG_BITS / 8;
        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
        cipher.init(Cipher.DECRYPT_MODE, new SecretKeySpec(Base64.decode(keyB64, Base64.NO_WRAP), "AES"),
            new GCMParameterSpec(TAG_BITS, Base64.decode(ivB64, Base64.NO_WRAP)));

        List<byte[]> plain = new ArrayList<>();
        long done = 0;
        for (int part = 0; done < total; part++) {
            byte[] chunk = fetchPart(id, part, apiBase, token);
            if (chunk.length == 0) throw new IllegalStateException("Potongan kosong");
            byte[] out = cipher.update(chunk);
            if (out != null && out.length > 0) plain.add(out);
            done += chunk.length;
            emitProgress(id, done, total);
        }
        plain.add(cipher.doFinal());
        return plain;
    }

    /**
     * Unduh dan dekripsi ke folder cache privat aplikasi (untuk diputar, bukan disimpan ke Download). Hasil: path
     * file sementara; pemanggil menghapusnya setelah selesai dipakai (AudioModule).
     */
    @ReactMethod
    public void downloadToCache(String id, String apiBase, String token, String keyB64, String ivB64,
                                double sizeBytes, Promise promise) {
        EXECUTOR.execute(() -> {
            File target = null;
            try {
                List<byte[]> plain = fetchAndDecrypt(id, apiBase, token, keyB64, ivB64, sizeBytes);
                File dir = new File(getReactApplicationContext().getCacheDir(), "voice");
                if (!dir.isDirectory() && !dir.mkdirs()) throw new IllegalStateException("Folder sementara gagal dibuat");
                target = new File(dir, id + ".audio");
                try (FileOutputStream out = new FileOutputStream(target)) {
                    for (byte[] piece : plain) out.write(piece);
                }
                promise.resolve(target.getAbsolutePath());
            } catch (Exception e) {
                if (target != null) target.delete();
                promise.reject("download_error", e.getMessage(), e);
            }
        });
    }

    /** Lokasi file yang sudah pernah diunduh untuk lampiran ini; null bila belum ada atau sudah dihapus pengguna. */
    @ReactMethod
    public void savedFile(String id, Promise promise) {
        String uri = downloads().getString(id, null);
        if (uri == null) {
            promise.resolve(null);
            return;
        }
        try (Cursor cursor = getReactApplicationContext().getContentResolver().query(Uri.parse(uri), null, null, null, null)) {
            if (cursor != null && cursor.moveToFirst()) {
                promise.resolve(uri);
                return;
            }
        } catch (Exception ignored) {
            // file dihapus atau tidak bisa diakses lagi: dianggap belum diunduh
        }
        downloads().edit().remove(id).apply();
        promise.resolve(null);
    }

    /** Simpan teks (cadangan riwayat chat) sebagai file .txt di Download/seru24; hasilnya nama file yang tersimpan. */
    @ReactMethod
    public void saveTextToDownloads(String name, String text, Promise promise) {
        EXECUTOR.execute(() -> {
            ContentResolver resolver = getReactApplicationContext().getContentResolver();
            Uri saved = null;
            try {
                ContentValues values = new ContentValues();
                values.put(MediaStore.Downloads.DISPLAY_NAME, name);
                values.put(MediaStore.Downloads.MIME_TYPE, "text/plain");
                values.put(MediaStore.Downloads.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS + "/seru24");
                values.put(MediaStore.Downloads.IS_PENDING, 1);
                saved = resolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values);
                if (saved == null) throw new IllegalStateException("Folder Download tidak bisa ditulis");
                try (OutputStream out = resolver.openOutputStream(saved)) {
                    if (out == null) throw new IllegalStateException("File tidak bisa ditulis");
                    out.write(text.getBytes(java.nio.charset.StandardCharsets.UTF_8));
                }
                values.clear();
                values.put(MediaStore.Downloads.IS_PENDING, 0);
                resolver.update(saved, values, null, null);
                promise.resolve(name);
            } catch (Exception e) {
                if (saved != null) resolver.delete(saved, null, null);
                promise.reject("save_error", e.getMessage(), e);
            }
        });
    }

    /** Baca file teks pilihan pengguna (cadangan); ditolak bila lebih besar dari batas agar memori aman. */
    @ReactMethod
    public void readTextFile(String uri, double maxBytes, Promise promise) {
        EXECUTOR.execute(() -> {
            try (InputStream in = getReactApplicationContext().getContentResolver().openInputStream(Uri.parse(uri))) {
                if (in == null) throw new IllegalStateException("File tidak bisa dibuka");
                ByteArrayOutputStream buffer = new ByteArrayOutputStream();
                byte[] chunk = new byte[64 * 1024];
                int read;
                while ((read = in.read(chunk)) > 0) {
                    buffer.write(chunk, 0, read);
                    if (buffer.size() > (long) maxBytes) throw new IllegalStateException("File terlalu besar");
                }
                promise.resolve(buffer.toString("UTF-8"));
            } catch (Exception e) {
                promise.reject("read_error", e.getMessage(), e);
            }
        });
    }

    /** Peta id lampiran -> content URI hasil unduhan (hanya lokasi file, tanpa kunci atau isi). */
    private SharedPreferences downloads() {
        return getReactApplicationContext().getSharedPreferences("seru24_downloads", Context.MODE_PRIVATE);
    }

    /** Buka file hasil unduhan dengan aplikasi yang sesuai (PDF, gambar, dll.). */
    @ReactMethod
    public void openFile(String uri, String mime, Promise promise) {
        try {
            Intent intent = new Intent(Intent.ACTION_VIEW)
                .setDataAndType(Uri.parse(uri), mime.isEmpty() ? "*/*" : mime)
                .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_ACTIVITY_NEW_TASK);
            getReactApplicationContext().startActivity(Intent.createChooser(intent, "Buka dengan")
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
            promise.resolve(null);
        } catch (Exception e) {
            promise.reject("open_error", e.getMessage(), e);
        }
    }

    private WritableMap describe(Uri uri) {
        WritableMap map = Arguments.createMap();
        map.putString("uri", uri.toString());
        String name = "dokumen";
        double size = -1;
        try (Cursor cursor = getReactApplicationContext().getContentResolver().query(uri, null, null, null, null)) {
            if (cursor != null && cursor.moveToFirst()) {
                int nameIndex = cursor.getColumnIndex(OpenableColumns.DISPLAY_NAME);
                int sizeIndex = cursor.getColumnIndex(OpenableColumns.SIZE);
                if (nameIndex >= 0 && !cursor.isNull(nameIndex)) name = cursor.getString(nameIndex);
                if (sizeIndex >= 0 && !cursor.isNull(sizeIndex)) size = cursor.getLong(sizeIndex);
            }
        }
        String mime = getReactApplicationContext().getContentResolver().getType(uri);
        map.putString("name", name);
        map.putDouble("size", size);
        map.putString("mime", mime == null ? "application/octet-stream" : mime);
        return map;
    }

    private long sizeOf(Uri uri) {
        double size = describe(uri).getDouble("size");
        if (size < 0) throw new IllegalStateException("Ukuran file tidak diketahui");
        return (long) size;
    }

    private static SecretKey newKey() throws Exception {
        KeyGenerator generator = KeyGenerator.getInstance("AES");
        generator.init(256);
        return generator.generateKey();
    }

    /**
     * Mengumpulkan ciphertext ke satu buffer tetap 3 MiB lalu mengirimnya per potongan, agar file 50 MB tidak
     * disalin berkali-kali di memori (penyedia kripto Android bisa menahan seluruh ciphertext sampai doFinal).
     */
    private final class ChunkUploader {
        private final long total;
        private final String id;
        private final String apiBase;
        private final String token;
        private final byte[] buffer = new byte[CHUNK_BYTES];
        private int filled = 0;
        private long offset = 0;

        ChunkUploader(long total, String id, String apiBase, String token) {
            this.total = total;
            this.id = id;
            this.apiBase = apiBase;
            this.token = token;
        }

        void feed(byte[] data) throws Exception {
            if (data == null) return;
            int pos = 0;
            while (pos < data.length) {
                int n = Math.min(CHUNK_BYTES - filled, data.length - pos);
                System.arraycopy(data, pos, buffer, filled, n);
                filled += n;
                pos += n;
                if (filled == CHUNK_BYTES) flush();
            }
        }

        void finish() throws Exception {
            if (filled > 0) flush();
            if (offset != total) throw new IllegalStateException("Ukuran unggahan tidak sesuai");
        }

        private void flush() throws Exception {
            offset = sendChunk(filled == CHUNK_BYTES ? buffer : Arrays.copyOf(buffer, filled), offset, total, id, apiBase, token);
            filled = 0;
        }
    }

    private long sendChunk(byte[] chunk, long offset, long total, String id, String apiBase, String token) throws Exception {
        Exception last = null;
        for (int attempt = 0; attempt < RETRIES; attempt++) {
            HttpURLConnection conn = (HttpURLConnection) new URL(apiBase + "/api/files/" + id + "/chunk").openConnection();
            try {
                conn.setRequestMethod("PUT");
                conn.setDoOutput(true);
                conn.setConnectTimeout(15_000);
                conn.setReadTimeout(60_000);
                conn.setFixedLengthStreamingMode(chunk.length);
                conn.setRequestProperty("Authorization", "Bearer " + token);
                // aplikasi native tidak mengirim Origin sendiri; server memeriksanya (sama seperti secureFetch mobile)
                conn.setRequestProperty("Origin", apiBase);
                conn.setRequestProperty("Content-Type", "application/octet-stream");
                conn.setRequestProperty("x-upload-offset", String.valueOf(offset));
                try (OutputStream out = conn.getOutputStream()) {
                    out.write(chunk);
                }
                int code = conn.getResponseCode();
                if (code != 200) throw new IllegalStateException("Unggah gagal (" + code + ")");
                JSONObject body = new JSONObject(readAll(conn.getInputStream()));
                long received = body.getBoolean("done") ? total : body.getLong("received");
                if (received != offset + chunk.length) throw new IllegalStateException("Unggahan terputus, coba lagi");
                emitProgress(id, received, total);
                return received;
            } catch (Exception e) {
                last = e;
                Thread.sleep(500L * (attempt + 1));
            } finally {
                conn.disconnect();
            }
        }
        throw last;
    }

    private byte[] fetchPart(String id, int part, String apiBase, String token) throws Exception {
        Exception last = null;
        for (int attempt = 0; attempt < RETRIES; attempt++) {
            HttpURLConnection conn = (HttpURLConnection) new URL(apiBase + "/api/files/" + id + "/chunk?part=" + part).openConnection();
            try {
                conn.setConnectTimeout(15_000);
                conn.setReadTimeout(60_000);
                conn.setRequestProperty("Authorization", "Bearer " + token);
                int code = conn.getResponseCode();
                if (code != 200) throw new IllegalStateException("Unduh gagal (" + code + ")");
                try (InputStream in = conn.getInputStream()) {
                    ByteArrayOutputStream out = new ByteArrayOutputStream(CHUNK_BYTES);
                    byte[] buffer = new byte[64 * 1024];
                    int read;
                    while ((read = in.read(buffer)) != -1) {
                        out.write(buffer, 0, read);
                        if (out.size() > CHUNK_BYTES) throw new IllegalStateException("Potongan terlalu besar");
                    }
                    return out.toByteArray();
                }
            } catch (Exception e) {
                last = e;
                Thread.sleep(500L * (attempt + 1));
            } finally {
                conn.disconnect();
            }
        }
        throw last;
    }

    private static String readAll(InputStream in) throws Exception {
        try (InputStream input = in) {
            ByteArrayOutputStream out = new ByteArrayOutputStream();
            byte[] buffer = new byte[4096];
            int read;
            while ((read = input.read(buffer)) != -1) out.write(buffer, 0, read);
            return out.toString("UTF-8");
        }
    }

    private void emitProgress(String id, long done, long total) {
        WritableMap map = Arguments.createMap();
        map.putString("id", id);
        map.putDouble("done", (double) done);
        map.putDouble("total", (double) total);
        getReactApplicationContext()
            .getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter.class)
            .emit(EVENT_PROGRESS, map);
    }
}
