package id.seru24.chat;

import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.os.Build;

import androidx.core.app.NotificationCompat;
import androidx.core.app.NotificationManagerCompat;

import com.facebook.react.bridge.Promise;
import com.facebook.react.bridge.ReactApplicationContext;
import com.facebook.react.bridge.ReactContextBaseJavaModule;
import com.facebook.react.bridge.ReactMethod;
import com.facebook.react.modules.core.DeviceEventManagerModule;
import com.google.firebase.FirebaseApp;
import com.google.firebase.messaging.FirebaseMessaging;

/**
 * Notifikasi "Pesan baru" di Android (lokal via Realtime maupun push via FCM saat aplikasi ditutup).
 * Isi pesan tidak pernah ditampilkan: terenkripsi dan layar kunci bisa dilihat orang lain.
 */
public class NotifyModule extends ReactContextBaseJavaModule {
    private static final String CHANNEL_ID = "messages";
    private static final int NOTIFICATION_ID = 1;
    private static final String PREFS = "seru24_notify_prefs";
    private static final String KEY_ENABLED = "enabled";
    private static final String EVENT_FCM_TOKEN = "seru24:fcm_token";

    private static volatile ReactApplicationContext activeContext;
    private static volatile String activeConversationId;
    private static volatile boolean appForeground;

    NotifyModule(ReactApplicationContext context) {
        super(context);
        activeContext = context;
        createChannel(context);
    }

    @Override
    public String getName() {
        return "Seru24Notify";
    }

    private static void createChannel(Context context) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) {
            return;
        }
        NotificationChannel channel = new NotificationChannel(CHANNEL_ID, "Pesan", NotificationManager.IMPORTANCE_HIGH);
        channel.setDescription("Pemberitahuan pesan baru");
        NotificationManager manager = context.getSystemService(NotificationManager.class);
        if (manager != null) {
            manager.createNotificationChannel(channel);
        }
    }

    public static boolean isEnabled(Context context) {
        return context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getBoolean(KEY_ENABLED, false);
    }

    public static boolean shouldSuppressForConversation(String conversationId) {
        return appForeground && conversationId != null && conversationId.equals(activeConversationId);
    }

    public static void emitNewToken(String token) {
        ReactApplicationContext ctx = activeContext;
        if (ctx != null && ctx.hasActiveReactInstance()) {
            ctx.getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter.class).emit(EVENT_FCM_TOKEN, token);
        }
    }

    /** tag = id percakapan, agar beberapa pesan dari percakapan yang sama digabung jadi satu notifikasi. */
    public static void showNotification(Context context, String title, String body, String tag) {
        createChannel(context);
        String notifyTag = (tag != null && !tag.isEmpty()) ? tag : "general";
        Intent intent = new Intent(context, MainActivity.class)
            .setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        if (tag != null && !tag.isEmpty()) {
            intent.putExtra("conversation_id", tag);
        }
        PendingIntent open = PendingIntent.getActivity(
            context, notifyTag.hashCode(), intent, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);

        NotificationCompat.Builder builder = new NotificationCompat.Builder(context, CHANNEL_ID)
            .setSmallIcon(R.mipmap.ic_launcher)
            .setContentTitle(title)
            .setContentText(body)
            .setAutoCancel(true)
            .setContentIntent(open)
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setVisibility(NotificationCompat.VISIBILITY_PRIVATE);
        try {
            NotificationManagerCompat.from(context).notify(notifyTag, NOTIFICATION_ID, builder.build());
        } catch (SecurityException e) {
            // izin POST_NOTIFICATIONS belum diberikan pengguna; abaikan
        }
    }

    @ReactMethod
    public void show(String title, String body, String tag) {
        showNotification(getReactApplicationContext(), title, body, tag);
    }

    @ReactMethod
    public void setEnabled(boolean enabled) {
        getReactApplicationContext()
            .getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            .edit()
            .putBoolean(KEY_ENABLED, enabled)
            .apply();
    }

    @ReactMethod
    public void setPresence(boolean foreground, String conversationId) {
        appForeground = foreground;
        activeConversationId = conversationId;
    }

    @ReactMethod
    public void getFcmToken(Promise promise) {
        try {
            Context context = getReactApplicationContext();
            if (FirebaseApp.getApps(context).isEmpty()) {
                FirebaseApp.initializeApp(context);
            }
            if (FirebaseApp.getApps(context).isEmpty()) {
                promise.resolve(null);
                return;
            }
            FirebaseMessaging.getInstance().getToken().addOnCompleteListener(task -> {
                if (!task.isSuccessful()) {
                    promise.resolve(null);
                    return;
                }
                promise.resolve(task.getResult());
            });
        } catch (Exception e) {
            promise.resolve(null);
        }
    }

    /** Diperlukan agar NativeEventEmitter / DeviceEventEmitter tidak mengeluarkan peringatan di RN. */
    @ReactMethod
    public void addListener(String eventName) {
    }

    @ReactMethod
    public void removeListeners(double count) {
    }
}
