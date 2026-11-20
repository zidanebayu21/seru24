package id.seru24.chat.rust;

import android.app.Application;

/**
 * Inisialisasi aplikasi host Gradle untuk library native Rust (`libseru24_app.so`).
 */
public class Seru24Application extends Application {
    @Override
    public void onCreate() {
        super.onCreate();
        Seru24Notifications.createChannel(this);
        Seru24Updater.cleanupUpdates(this);
    }
}
