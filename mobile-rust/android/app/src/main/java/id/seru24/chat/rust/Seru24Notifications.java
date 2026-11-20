package id.seru24.chat.rust;

import android.Manifest;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.os.Build;

import androidx.core.app.NotificationCompat;
import androidx.core.app.NotificationManagerCompat;
import androidx.core.content.ContextCompat;

import com.google.firebase.FirebaseApp;
import com.google.firebase.messaging.FirebaseMessaging;

/**
 * Notifikasi lokal + FCM data-only ("Pesan baru" tanpa bocoran isi di layar kunci).
 */
final class Seru24Notifications {
    private static final String CHANNEL_ID = "messages";
    private static final int NOTIFICATION_ID = 1;
    private static final String PREFS = "seru24_notify_prefs";
    private static final String KEY_ENABLED = "enabled";

    private static volatile boolean appForeground;
    private static volatile String activeConversationId = "";

    private Seru24Notifications() {}

    static void createChannel(Context context) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
        NotificationChannel ch = new NotificationChannel(CHANNEL_ID, "Pesan", NotificationManager.IMPORTANCE_HIGH);
        ch.setDescription("Pemberitahuan pesan baru");
        NotificationManager mgr = context.getSystemService(NotificationManager.class);
        if (mgr != null) mgr.createNotificationChannel(ch);
    }

    static void setAppForeground(boolean fg) {
        appForeground = fg;
    }

    private static volatile boolean notificationPermissionAsked;
    private static volatile boolean fcmTokenRequested;

    static void setPresence(Context context, boolean enabled, boolean foreground, String conversationId) {
        appForeground = foreground;
        activeConversationId = conversationId == null ? "" : conversationId;
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().putBoolean(KEY_ENABLED, enabled).apply();
        if (!enabled) {
            return;
        }
        if (Build.VERSION.SDK_INT < 33 || ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED) {
            requestFcmTokenOnce(context);
            return;
        }
        // Presence berubah tiap pindah layar: dialog izin cukup sekali per proses, tidak diulang tiap perubahan.
        if (notificationPermissionAsked) {
            return;
        }
        notificationPermissionAsked = true;
        Seru24Activity.ensurePermissions(new String[]{Manifest.permission.POST_NOTIFICATIONS}, granted -> {
            if (granted) requestFcmTokenOnce(context);
        });
    }

    private static void requestFcmTokenOnce(Context context) {
        if (fcmTokenRequested) {
            return;
        }
        fcmTokenRequested = true;
        requestFcmToken(context);
    }

    static boolean isEnabled(Context context) {
        return context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getBoolean(KEY_ENABLED, false);
    }

    static boolean shouldSuppress(String conversationId) {
        return appForeground && conversationId != null && !conversationId.isEmpty() && conversationId.equals(activeConversationId);
    }

    static void show(Context context, String title, String body, String tag) {
        createChannel(context);
        String notifyTag = (tag != null && !tag.isEmpty()) ? tag : "general";
        Intent intent = new Intent(context, Seru24Activity.class)
            .setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        if (tag != null && !tag.isEmpty()) intent.putExtra("conversation_id", tag);
        PendingIntent open = PendingIntent.getActivity(
            context, notifyTag.hashCode(), intent, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);

        NotificationCompat.Builder builder = new NotificationCompat.Builder(context, CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_notification)
            .setContentTitle(title)
            .setContentText(body)
            .setAutoCancel(true)
            .setContentIntent(open)
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setVisibility(NotificationCompat.VISIBILITY_PRIVATE);
        try {
            NotificationManagerCompat.from(context).notify(notifyTag, NOTIFICATION_ID, builder.build());
        } catch (SecurityException ignored) {
            // Izin POST_NOTIFICATIONS belum diberikan.
        }
    }

    static String requestFcmToken(Context context) {
        try {
            if (FirebaseApp.getApps(context).isEmpty()) {
                FirebaseApp.initializeApp(context);
            }
            if (FirebaseApp.getApps(context).isEmpty()) {
                return null;
            }
            FirebaseMessaging.getInstance().getToken().addOnSuccessListener(token -> {
                if (token != null && !token.isEmpty()) {
                    NativeBridge.onFcmToken(token);
                }
            });
        } catch (Exception ignored) {
            // google-services.json tidak dibundel pada build ini; abaikan dengan aman.
        }
        return null;
    }
}
