package id.seru24.chat.rust;

import androidx.annotation.NonNull;

import com.google.firebase.messaging.FirebaseMessagingService;
import com.google.firebase.messaging.RemoteMessage;

import java.util.Map;

/**
 * Penerima FCM latar belakang; tidak pernah memunculkan isi pesan maupun pengirim di notifikasi.
 */
public class Seru24FcmService extends FirebaseMessagingService {
    @Override
    public void onNewToken(@NonNull String token) {
        if (!token.isEmpty()) {
            NativeBridge.onFcmToken(token);
        }
    }

    @Override
    public void onMessageReceived(@NonNull RemoteMessage message) {
        if (!Seru24Notifications.isEnabled(getApplicationContext())) return;
        Map<String, String> data = message.getData();
        String conversationId = data.get("conversation_id");
        if (Seru24Notifications.shouldSuppress(conversationId)) return;
        Seru24Notifications.show(getApplicationContext(), "seru24", "Pesan baru", conversationId);
    }
}
