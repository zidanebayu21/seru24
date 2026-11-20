package id.seru24.chat.rust;

import android.content.Context;
import android.content.Intent;
import android.content.res.Configuration;
import android.net.Uri;

/**
 * Facade statis JNI yang dipanggil langsung oleh kode Rust (`seru24-app/src/platform.rs`).
 */
public final class NativeBridge {
    private NativeBridge() {}

    // Callback dari Java -> Rust (diimplementasikan via #[no_mangle] di platform.rs).
    public static native void onFcmToken(String token);
    public static native void onFilesPicked(String jsonArray);
    public static native void onFileProgress(String id, long done, long total);
    public static native void onNearbyEvent(String kind, String endpointId, String value);
    public static native void onWebRtcOffer(String sdp);
    public static native void onWebRtcAnswer(String sdp);
    public static native void onWebRtcIce(String candidateJson);
    public static native void onWebRtcState(String state);

    // Kunci & Tema
    public static String getOrCreateMasterKey(Context ctx) {
        return Seru24Keystore.getOrCreateMasterKey(ctx);
    }

    public static boolean isSystemDarkMode(Context ctx) {
        int night = ctx.getResources().getConfiguration().uiMode & Configuration.UI_MODE_NIGHT_MASK;
        return night == Configuration.UI_MODE_NIGHT_YES;
    }

    public static void openUrl(Context ctx, String url) {
        try {
            Intent i = new Intent(Intent.ACTION_VIEW, Uri.parse(url)).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            ctx.startActivity(i);
        } catch (Exception ignored) {
            // Tidak ada browser yang dapat membuka tautan.
        }
    }

    // Notifikasi & FCM
    public static void showNotification(Context ctx, String title, String body, String tag) {
        Seru24Notifications.show(ctx, title, body, tag);
    }

    public static void setNotifyPresence(Context ctx, boolean enabled, boolean foreground, String conversationId) {
        Seru24Notifications.setPresence(ctx, enabled, foreground, conversationId);
    }

    public static String requestFcmToken(Context ctx) {
        return Seru24Notifications.requestFcmToken(ctx);
    }

    // Berkas & Pemutar Suara
    public static boolean pickFiles(Context ctx) {
        return Seru24Files.pickFiles(ctx);
    }

    public static String saveTextToDownloads(Context ctx, String name, String text) {
        return Seru24Files.saveTextToDownloads(ctx, name, text);
    }

    public static String readTextUri(Context ctx, String uri) {
        return Seru24Files.readTextUri(ctx, uri, 20 * 1024 * 1024);
    }

    public static String encryptAndUpload(Context ctx, String uri, String attachmentId, String apiBase, String token) {
        return Seru24Files.encryptAndUpload(ctx, uri, attachmentId, apiBase, token);
    }

    public static String downloadAndSave(Context ctx, String fileMetaJson, String apiBase, String token) {
        return Seru24Files.downloadAndSave(ctx, fileMetaJson, apiBase, token);
    }

    public static void openFile(Context ctx, String uri, String mime) {
        Seru24Files.openFile(ctx, uri, mime);
    }

    public static void playVoice(Context ctx, String path) {
        Seru24Files.playVoice(path);
    }

    // Siaran Dekat
    public static String nearbyStart(Context ctx, String endpointName) {
        return Seru24Nearby.start(ctx, endpointName);
    }

    public static void nearbyStop(Context ctx) {
        Seru24Nearby.stop(ctx);
    }

    public static void nearbyRequest(Context ctx, String endpointId, String localName) {
        Seru24Nearby.request(ctx, endpointId, localName);
    }

    public static void nearbyAccept(Context ctx, String endpointId) {
        Seru24Nearby.accept(ctx, endpointId);
    }

    public static void nearbyReject(Context ctx, String endpointId) {
        Seru24Nearby.reject(ctx, endpointId);
    }

    public static void nearbySend(Context ctx, String endpointId, String payload) {
        Seru24Nearby.send(ctx, endpointId, payload);
    }

    // Telepon Suara & WebRTC
    public static void callAudioBegin(Context ctx) {
        Seru24CallWebRtc.audioBegin(ctx);
    }

    public static void callAudioSpeaker(Context ctx, boolean on) {
        Seru24CallWebRtc.audioSpeaker(ctx, on);
    }

    public static void callAudioEnd(Context ctx) {
        Seru24CallWebRtc.audioEnd(ctx);
    }

    public static boolean webrtcCreateOffer(Context ctx, int bitrate) {
        return Seru24CallWebRtc.createOffer(ctx, bitrate);
    }

    public static void webrtcHandleOffer(Context ctx, String sdp, int bitrate) {
        Seru24CallWebRtc.handleOffer(ctx, sdp, bitrate);
    }

    public static void webrtcHandleAnswer(Context ctx, String sdp) {
        Seru24CallWebRtc.handleAnswer(sdp);
    }

    public static void webrtcAddIce(Context ctx, String candidateJson) {
        Seru24CallWebRtc.addIce(candidateJson);
    }

    public static void webrtcSetMuted(Context ctx, boolean muted) {
        Seru24CallWebRtc.setMuted(muted);
    }

    public static void webrtcClose(Context ctx) {
        Seru24CallWebRtc.close();
    }

    // Pembaruan APK
    public static String downloadAndInstallUpdate(Context ctx, String url, String sha256) {
        return Seru24Updater.downloadAndInstall(ctx, url, sha256);
    }
}
