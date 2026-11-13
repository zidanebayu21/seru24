package id.seru24.chat;

import androidx.annotation.NonNull;

import com.google.firebase.messaging.FirebaseMessagingService;
import com.google.firebase.messaging.RemoteMessage;

import java.util.Map;

/**
 * Penerima FCM data-only di latar belakang / saat proses aplikasi ditutup penuh.
 * Hanya menampilkan "Pesan baru" tanpa isi pesan maupun nama pengirim.
 */
public class Seru24FcmService extends FirebaseMessagingService {
    @Override
    public void onNewToken(@NonNull String token) {
        NotifyModule.emitNewToken(token);
    }

    @Override
    public void onMessageReceived(@NonNull RemoteMessage message) {
        if (!NotifyModule.isEnabled(getApplicationContext())) {
            return;
        }
        Map<String, String> data = message.getData();
        String conversationId = data.get("conversation_id");
        if (NotifyModule.shouldSuppressForConversation(conversationId)) {
            return;
        }
        NotifyModule.showNotification(getApplicationContext(), "seru24", "Pesan baru", conversationId);
    }
}
