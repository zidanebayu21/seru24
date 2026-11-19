package id.seru24.chat;

import android.media.AudioAttributes;
import android.media.MediaPlayer;
import android.os.Handler;
import android.os.Looper;

import com.facebook.react.bridge.Arguments;
import com.facebook.react.bridge.Promise;
import com.facebook.react.bridge.ReactApplicationContext;
import com.facebook.react.bridge.ReactContextBaseJavaModule;
import com.facebook.react.bridge.ReactMethod;
import com.facebook.react.bridge.WritableMap;
import com.facebook.react.modules.core.DeviceEventManagerModule;

import java.io.File;

/**
 * Pemutar pesan suara memakai MediaPlayer bawaan Android (tanpa pustaka tambahan). Berkas yang diputar adalah hasil
 * dekripsi di cache privat aplikasi (FileModule.downloadToCache); dihapus begitu pemutaran berakhir, dihentikan,
 * atau gagal agar suara yang sudah didekripsi tidak tertinggal di penyimpanan. Hanya satu pemutar pada satu waktu.
 */
public class AudioModule extends ReactContextBaseJavaModule {
    private static final String EVENT = "seru24AudioState";
    private static final long TICK_MS = 250;

    private final Handler main = new Handler(Looper.getMainLooper());
    private MediaPlayer player;
    private String currentId;
    private File currentFile;
    private final Runnable ticker = new Runnable() {
        @Override
        public void run() {
            if (player != null && player.isPlaying()) {
                emit("playing");
                main.postDelayed(this, TICK_MS);
            }
        }
    };

    AudioModule(ReactApplicationContext context) {
        super(context);
    }

    @Override
    public String getName() {
        return "Seru24Audio";
    }

    @ReactMethod
    public void play(String id, String path, Promise promise) {
        main.post(() -> {
            release("stopped");
            File file = new File(path);
            try {
                MediaPlayer created = new MediaPlayer();
                created.setAudioAttributes(new AudioAttributes.Builder()
                    .setUsage(AudioAttributes.USAGE_MEDIA)
                    .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
                    .build());
                created.setDataSource(path);
                currentId = id;
                currentFile = file;
                player = created;
                created.setOnPreparedListener(p -> {
                    p.start();
                    emit("playing");
                    main.postDelayed(ticker, TICK_MS);
                    promise.resolve(null);
                });
                created.setOnCompletionListener(p -> release("ended"));
                created.setOnErrorListener((p, what, extra) -> {
                    release("error");
                    promise.reject("play_error", "Pesan suara tidak bisa diputar");
                    return true;
                });
                created.prepareAsync();
            } catch (Exception e) {
                release("error");
                file.delete();
                promise.reject("play_error", e.getMessage(), e);
            }
        });
    }

    @ReactMethod
    public void pause() {
        main.post(() -> {
            if (player != null && player.isPlaying()) {
                player.pause();
                emit("paused");
            }
        });
    }

    @ReactMethod
    public void resume() {
        main.post(() -> {
            if (player != null && !player.isPlaying()) {
                player.start();
                emit("playing");
                main.postDelayed(ticker, TICK_MS);
            }
        });
    }

    @ReactMethod
    public void stop() {
        main.post(() -> release("stopped"));
    }

    /** Hentikan pemutar, hapus berkas sementara, dan kabari JS (hanya bila ada yang sedang dipakai). */
    private void release(String state) {
        main.removeCallbacks(ticker);
        if (player == null) return;
        emit(state);
        try {
            player.release();
        } catch (Exception ignored) {
            // pemutar sudah dilepas sistem
        }
        player = null;
        if (currentFile != null) currentFile.delete();
        currentFile = null;
        currentId = null;
    }

    private void emit(String state) {
        if (currentId == null) return;
        WritableMap map = Arguments.createMap();
        map.putString("id", currentId);
        map.putString("state", state);
        int position = 0;
        int duration = 0;
        try {
            if (player != null) {
                position = player.getCurrentPosition();
                duration = player.getDuration();
            }
        } catch (IllegalStateException ignored) {
            // belum siap atau sudah dilepas: posisi 0
        }
        map.putInt("positionMs", position);
        map.putInt("durationMs", Math.max(duration, 0));
        getReactApplicationContext()
            .getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter.class)
            .emit(EVENT, map);
    }
}
