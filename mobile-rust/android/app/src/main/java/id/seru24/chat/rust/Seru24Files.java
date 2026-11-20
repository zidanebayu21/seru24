package id.seru24.chat.rust;

import android.app.Activity;
import android.content.ClipData;
import android.content.ContentResolver;
import android.content.ContentValues;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.database.Cursor;
import android.media.AudioAttributes;
import android.media.MediaPlayer;
import android.net.Uri;
import android.os.Environment;
import android.os.Handler;
import android.os.Looper;
import android.provider.MediaStore;
import android.provider.OpenableColumns;
import android.util.Base64;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.security.SecureRandom;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;

import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;
import javax.crypto.spec.SecretKeySpec;

/**
 * Manajemen file terenkripsi AES-256-GCM per potongan 3 MiB, penyimpanan Download/seru24,
 * pembacaan file cadangan, dan pemutaran pesan suara via MediaPlayer.
 */
final class Seru24Files {
    private static final int CHUNK_BYTES = 3 * 1024 * 1024;
    private static final int TAG_BITS = 128;
    private static final int RETRIES = 3;

    private static final Handler MAIN = new Handler(Looper.getMainLooper());
    private static MediaPlayer voicePlayer;
    private static File voiceCacheFile;

    private Seru24Files() {}

    static boolean pickFiles(Context context) {
        return Seru24Activity.launchFilePicker((resultCode, data) -> {
            JSONArray out = new JSONArray();
            if (resultCode == Activity.RESULT_OK && data != null) {
                ClipData clip = data.getClipData();
                if (clip != null) {
                    for (int i = 0; i < clip.getItemCount(); i++) {
                        JSONObject desc = describeUri(context, clip.getItemAt(i).getUri());
                        if (desc != null) out.put(desc);
                    }
                } else if (data.getData() != null) {
                    JSONObject desc = describeUri(context, data.getData());
                    if (desc != null) out.put(desc);
                }
            }
            NativeBridge.onFilesPicked(out.toString());
        });
    }

    private static JSONObject describeUri(Context context, Uri uri) {
        if (uri == null) return null;
        String name = "dokumen";
        long size = 0;
        ContentResolver resolver = context.getContentResolver();
        try (Cursor c = resolver.query(uri, null, null, null, null)) {
            if (c != null && c.moveToFirst()) {
                int ni = c.getColumnIndex(OpenableColumns.DISPLAY_NAME);
                int si = c.getColumnIndex(OpenableColumns.SIZE);
                if (ni >= 0 && !c.isNull(ni)) name = c.getString(ni);
                if (si >= 0 && !c.isNull(si)) size = c.getLong(si);
            }
        } catch (Exception ignored) {
            // Gunakan fallback nama default jika provider tidak mendukung query kolom.
        }
        String mime = resolver.getType(uri);
        try {
            JSONObject obj = new JSONObject();
            obj.put("uri", uri.toString());
            obj.put("name", name);
            obj.put("size", Math.max(0L, size));
            obj.put("mime", (mime == null || mime.isEmpty()) ? "application/octet-stream" : mime);
            return obj;
        } catch (Exception e) {
            return null;
        }
    }

    static String saveTextToDownloads(Context context, String name, String text) {
        ContentResolver resolver = context.getContentResolver();
        Uri saved = null;
        try {
            ContentValues values = new ContentValues();
            values.put(MediaStore.Downloads.DISPLAY_NAME, name);
            values.put(MediaStore.Downloads.MIME_TYPE, "text/plain");
            values.put(MediaStore.Downloads.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS + "/seru24");
            values.put(MediaStore.Downloads.IS_PENDING, 1);
            saved = resolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values);
            if (saved == null) return null;
            try (OutputStream out = resolver.openOutputStream(saved)) {
                if (out == null) {
                    resolver.delete(saved, null, null);
                    return null;
                }
                out.write(text.getBytes(StandardCharsets.UTF_8));
            }
            values.clear();
            values.put(MediaStore.Downloads.IS_PENDING, 0);
            resolver.update(saved, values, null, null);
            return Environment.DIRECTORY_DOWNLOADS + "/seru24/" + name;
        } catch (Exception e) {
            if (saved != null) resolver.delete(saved, null, null);
            return null;
        }
    }

    static String readTextUri(Context context, String uriStr, int maxBytes) {
        try (InputStream in = context.getContentResolver().openInputStream(Uri.parse(uriStr))) {
            if (in == null) return null;
            ByteArrayOutputStream out = new ByteArrayOutputStream();
            byte[] buf = new byte[64 * 1024];
            int r;
            while ((r = in.read(buf)) > 0) {
                out.write(buf, 0, r);
                if (out.size() > maxBytes) return null;
            }
            return out.toString(StandardCharsets.UTF_8.name());
        } catch (Exception e) {
            return null;
        }
    }

    static String encryptAndUpload(Context context, String uriStr, String id, String apiBase, String token) {
        try {
            ContentResolver resolver = context.getContentResolver();
            Uri uri = Uri.parse(uriStr);
            long size = describeUri(context, uri).getLong("size");
            if (size <= 0) throw new IllegalStateException("Ukuran file tidak diketahui");

            KeyGenerator gen = KeyGenerator.getInstance("AES");
            gen.init(256);
            SecretKey key = gen.generateKey();
            byte[] iv = new byte[12];
            new SecureRandom().nextBytes(iv);

            Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
            cipher.init(Cipher.ENCRYPT_MODE, key, new GCMParameterSpec(TAG_BITS, iv));

            long total = size + TAG_BITS / 8;
            byte[] chunkBuf = new byte[CHUNK_BYTES];
            int filled = 0;
            long offset = 0;

            try (InputStream in = resolver.openInputStream(uri)) {
                if (in == null) throw new IllegalStateException("File tidak dapat dibaca");
                byte[] buf = new byte[256 * 1024];
                int read;
                while ((read = in.read(buf)) != -1) {
                    byte[] ct = cipher.update(buf, 0, read);
                    if (ct != null) {
                        int pos = 0;
                        while (pos < ct.length) {
                            int n = Math.min(CHUNK_BYTES - filled, ct.length - pos);
                            System.arraycopy(ct, pos, chunkBuf, filled, n);
                            filled += n;
                            pos += n;
                            if (filled == CHUNK_BYTES) {
                                offset = sendChunk(chunkBuf, filled, offset, total, id, apiBase, token);
                                filled = 0;
                            }
                        }
                    }
                }
            }
            byte[] tail = cipher.doFinal();
            int pos = 0;
            while (pos < tail.length) {
                int n = Math.min(CHUNK_BYTES - filled, tail.length - pos);
                System.arraycopy(tail, pos, chunkBuf, filled, n);
                filled += n;
                pos += n;
                if (filled == CHUNK_BYTES) {
                    offset = sendChunk(chunkBuf, filled, offset, total, id, apiBase, token);
                    filled = 0;
                }
            }
            if (filled > 0) {
                offset = sendChunk(chunkBuf, filled, offset, total, id, apiBase, token);
            }
            if (offset != total) throw new IllegalStateException("Ukuran unggahan tidak sesuai");

            JSONObject res = new JSONObject();
            res.put("key", Base64.encodeToString(key.getEncoded(), Base64.NO_WRAP));
            res.put("iv", Base64.encodeToString(iv, Base64.NO_WRAP));
            return res.toString();
        } catch (Exception e) {
            try {
                return new JSONObject().put("error", e.getMessage() == null ? "Unggah gagal" : e.getMessage()).toString();
            } catch (Exception ignored) {
                return "{\"error\":\"Unggah gagal\"}";
            }
        }
    }

    private static long sendChunk(byte[] buf, int len, long offset, long total, String id, String apiBase, String token) throws Exception {
        byte[] payload = len == buf.length ? buf : Arrays.copyOf(buf, len);
        Exception last = null;
        for (int attempt = 0; attempt < RETRIES; attempt++) {
            HttpURLConnection conn = (HttpURLConnection) new URL(apiBase + "/api/files/" + id + "/chunk").openConnection();
            try {
                conn.setRequestMethod("PUT");
                conn.setDoOutput(true);
                conn.setConnectTimeout(15_000);
                conn.setReadTimeout(60_000);
                conn.setFixedLengthStreamingMode(payload.length);
                conn.setRequestProperty("Authorization", "Bearer " + token);
                conn.setRequestProperty("Origin", apiBase);
                conn.setRequestProperty("Content-Type", "application/octet-stream");
                conn.setRequestProperty("x-upload-offset", String.valueOf(offset));
                try (OutputStream out = conn.getOutputStream()) {
                    out.write(payload);
                }
                int code = conn.getResponseCode();
                if (code != 200) throw new IllegalStateException("Unggah gagal (" + code + ")");
                JSONObject body = new JSONObject(readUtf8(conn.getInputStream()));
                long received = body.getBoolean("done") ? total : body.getLong("received");
                if (received != offset + payload.length) throw new IllegalStateException("Unggahan terputus");
                NativeBridge.onFileProgress(id, received, total);
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

    static String downloadAndSave(Context context, String fileMetaJson, String apiBase, String token) {
        try {
            JSONObject meta = new JSONObject(fileMetaJson);
            String id = meta.getString("id");
            String keyB64 = meta.getString("key");
            String ivB64 = meta.getString("iv");
            String name = meta.optString("name", "lampiran");
            String mime = meta.optString("mime", "application/octet-stream");
            long sizeBytes = meta.getLong("size");
            boolean isVoice = mime.startsWith("audio/");

            if (!isVoice) {
                SharedPreferences prefs = context.getSharedPreferences("seru24_downloads", Context.MODE_PRIVATE);
                String existing = prefs.getString(id, null);
                if (existing != null) {
                    try (Cursor c = context.getContentResolver().query(Uri.parse(existing), null, null, null, null)) {
                        if (c != null && c.moveToFirst()) return existing;
                    } catch (Exception ignored) {
                        // File tidak dapat diakses lagi; unduh ulang.
                    }
                }
            }

            long total = sizeBytes + TAG_BITS / 8;
            Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
            cipher.init(
                Cipher.DECRYPT_MODE,
                new SecretKeySpec(Base64.decode(keyB64, Base64.NO_WRAP), "AES"),
                new GCMParameterSpec(TAG_BITS, Base64.decode(ivB64, Base64.NO_WRAP))
            );
            List<byte[]> plain = new ArrayList<>();
            long done = 0;
            for (int part = 0; done < total; part++) {
                byte[] chunk = fetchPart(id, part, apiBase, token);
                if (chunk.length == 0) throw new IllegalStateException("Potongan file kosong");
                byte[] dec = cipher.update(chunk);
                if (dec != null && dec.length > 0) plain.add(dec);
                done += chunk.length;
                NativeBridge.onFileProgress(id, done, total);
            }
            plain.add(cipher.doFinal());

            if (isVoice) {
                File dir = new File(context.getCacheDir(), "voice");
                if (!dir.isDirectory() && !dir.mkdirs()) throw new IllegalStateException("Folder cache gagal dibuat");
                File target = new File(dir, id + ".audio");
                try (FileOutputStream out = new FileOutputStream(target)) {
                    for (byte[] p : plain) out.write(p);
                }
                return target.getAbsolutePath();
            }

            ContentResolver resolver = context.getContentResolver();
            ContentValues values = new ContentValues();
            values.put(MediaStore.Downloads.DISPLAY_NAME, name);
            values.put(MediaStore.Downloads.MIME_TYPE, mime.isEmpty() ? "application/octet-stream" : mime);
            values.put(MediaStore.Downloads.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS + "/seru24");
            values.put(MediaStore.Downloads.IS_PENDING, 1);
            Uri saved = resolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values);
            if (saved == null) throw new IllegalStateException("Folder Download tidak bisa ditulis");
            try {
                try (OutputStream out = resolver.openOutputStream(saved)) {
                    if (out == null) throw new IllegalStateException("File tidak bisa ditulis");
                    for (byte[] p : plain) out.write(p);
                }
                values.clear();
                values.put(MediaStore.Downloads.IS_PENDING, 0);
                resolver.update(saved, values, null, null);
                context.getSharedPreferences("seru24_downloads", Context.MODE_PRIVATE)
                    .edit()
                    .putString(id, saved.toString())
                    .apply();
                return saved.toString();
            } catch (Exception e) {
                resolver.delete(saved, null, null);
                throw e;
            }
        } catch (Exception e) {
            return "ERR:" + (e.getMessage() == null ? "Unduh gagal" : e.getMessage());
        }
    }

    private static byte[] fetchPart(String id, int part, String apiBase, String token) throws Exception {
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
                    byte[] buf = new byte[64 * 1024];
                    int read;
                    while ((read = in.read(buf)) != -1) {
                        out.write(buf, 0, read);
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

    private static String readUtf8(InputStream in) throws Exception {
        try (InputStream input = in) {
            ByteArrayOutputStream out = new ByteArrayOutputStream();
            byte[] buf = new byte[4096];
            int read;
            while ((read = input.read(buf)) != -1) out.write(buf, 0, read);
            return out.toString(StandardCharsets.UTF_8.name());
        }
    }

    static void openFile(Context context, String uri, String mime) {
        try {
            Intent intent = new Intent(Intent.ACTION_VIEW)
                .setDataAndType(Uri.parse(uri), (mime == null || mime.isEmpty()) ? "*/*" : mime)
                .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_ACTIVITY_NEW_TASK);
            context.startActivity(Intent.createChooser(intent, "Buka dengan").addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
        } catch (Exception ignored) {
            // Tidak ada penampil yang sesuai di perangkat.
        }
    }

    static void playVoice(String path) {
        MAIN.post(() -> {
            stopVoiceInternal();
            File f = new File(path);
            try {
                MediaPlayer mp = new MediaPlayer();
                mp.setAudioAttributes(new AudioAttributes.Builder()
                    .setUsage(AudioAttributes.USAGE_MEDIA)
                    .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
                    .build());
                mp.setDataSource(path);
                voicePlayer = mp;
                voiceCacheFile = f;
                mp.setOnPreparedListener(MediaPlayer::start);
                mp.setOnCompletionListener(p -> stopVoiceInternal());
                mp.setOnErrorListener((p, w, e) -> {
                    stopVoiceInternal();
                    return true;
                });
                mp.prepareAsync();
            } catch (Exception e) {
                stopVoiceInternal();
                if (f.isFile()) f.delete();
            }
        });
    }

    static void stopVoice() {
        MAIN.post(Seru24Files::stopVoiceInternal);
    }

    private static void stopVoiceInternal() {
        if (voicePlayer != null) {
            try {
                voicePlayer.release();
            } catch (Exception ignored) {
                // Pemutar sudah dilepas sistem.
            }
            voicePlayer = null;
        }
        if (voiceCacheFile != null) {
            voiceCacheFile.delete();
            voiceCacheFile = null;
        }
    }
}
