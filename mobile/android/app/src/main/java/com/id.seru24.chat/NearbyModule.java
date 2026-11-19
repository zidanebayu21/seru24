package id.seru24.chat;

import androidx.annotation.NonNull;

import com.facebook.react.bridge.Arguments;
import com.facebook.react.bridge.Promise;
import com.facebook.react.bridge.ReactApplicationContext;
import com.facebook.react.bridge.ReactContextBaseJavaModule;
import com.facebook.react.bridge.ReactMethod;
import com.facebook.react.bridge.WritableMap;
import com.facebook.react.modules.core.DeviceEventManagerModule;
import com.google.android.gms.nearby.Nearby;
import com.google.android.gms.nearby.connection.AdvertisingOptions;
import com.google.android.gms.nearby.connection.ConnectionInfo;
import com.google.android.gms.nearby.connection.ConnectionLifecycleCallback;
import com.google.android.gms.nearby.connection.ConnectionResolution;
import com.google.android.gms.nearby.connection.ConnectionsClient;
import com.google.android.gms.nearby.connection.DiscoveredEndpointInfo;
import com.google.android.gms.nearby.connection.DiscoveryOptions;
import com.google.android.gms.nearby.connection.EndpointDiscoveryCallback;
import com.google.android.gms.nearby.connection.Payload;
import com.google.android.gms.nearby.connection.PayloadCallback;
import com.google.android.gms.nearby.connection.PayloadTransferUpdate;
import com.google.android.gms.nearby.connection.Strategy;

import java.nio.charset.StandardCharsets;

/**
 * Mode Dekat: koneksi langsung antar dua HP tanpa internet memakai Nearby Connections (BLE untuk menemukan, lalu
 * Bluetooth atau Wi-Fi Direct untuk data). Satu sesi hanya untuk satu lawan bicara: nama yang diumumkan adalah tag
 * turunan (bukan username) dan koneksi dari nama lain ditolak. Modul ini hanya mengangkut byte; keaslian dan isi
 * pesan diperiksa di sisi JS lewat dekripsi AES-GCM E2EE. Payload hanya BYTES (maks 32 KB), tanpa file.
 */
public class NearbyModule extends ReactContextBaseJavaModule {
    private static final String EVENT = "seru24NearbyEvent";
    private static final String SERVICE_ID = "id.seru24.chat.nearby";
    private static final Strategy STRATEGY = Strategy.P2P_POINT_TO_POINT;

    private ConnectionsClient client;
    private boolean active;
    private String localTag;
    private String peerTag;
    private String endpointId;
    private boolean connecting;

    NearbyModule(ReactApplicationContext context) {
        super(context);
    }

    @NonNull
    @Override
    public String getName() {
        return "Seru24Nearby";
    }

    private ConnectionsClient client() {
        if (client == null) client = Nearby.getConnectionsClient(getReactApplicationContext());
        return client;
    }

    private void emit(String type, String value) {
        WritableMap map = Arguments.createMap();
        map.putString("type", type);
        map.putString("value", value);
        try {
            getReactApplicationContext().getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter.class).emit(EVENT, map);
        } catch (RuntimeException ignored) {
            // JS belum siap atau sedang dimuat ulang: status dikirim ulang pada kejadian berikutnya
        }
    }

    private final PayloadCallback payloadCallback = new PayloadCallback() {
        @Override
        public void onPayloadReceived(@NonNull String id, @NonNull Payload payload) {
            byte[] bytes = payload.asBytes();
            if (!id.equals(endpointId) || payload.getType() != Payload.Type.BYTES || bytes == null) return;
            emit("payload", new String(bytes, StandardCharsets.UTF_8));
        }

        @Override
        public void onPayloadTransferUpdate(@NonNull String id, @NonNull PayloadTransferUpdate update) {
            // payload kecil (BYTES) selalu tiba utuh; tidak ada progres untuk dilacak
        }
    };

    private final ConnectionLifecycleCallback lifecycle = new ConnectionLifecycleCallback() {
        @Override
        public void onConnectionInitiated(@NonNull String id, @NonNull ConnectionInfo info) {
            // hanya lawan bicara percakapan ini; selain itu ditolak sebelum ada data yang diterima
            if (!active || endpointId != null || !info.getEndpointName().equals(peerTag)) {
                client().rejectConnection(id);
                return;
            }
            connecting = true;
            emit("state", "connecting");
            client().acceptConnection(id, payloadCallback);
        }

        @Override
        public void onConnectionResult(@NonNull String id, @NonNull ConnectionResolution result) {
            connecting = false;
            if (active && result.getStatus().isSuccess()) {
                endpointId = id;
                // hemat baterai: berhenti mencari selama sudah tersambung
                client().stopAdvertising();
                client().stopDiscovery();
                emit("state", "connected");
            } else if (active) {
                emit("state", "searching");
            }
        }

        @Override
        public void onDisconnected(@NonNull String id) {
            if (!id.equals(endpointId)) return;
            endpointId = null;
            if (active) {
                emit("state", "searching");
                beginSearch(null);
            }
        }
    };

    private final EndpointDiscoveryCallback discovery = new EndpointDiscoveryCallback() {
        @Override
        public void onEndpointFound(@NonNull String id, @NonNull DiscoveredEndpointInfo info) {
            // Hanya satu pihak yang meminta koneksi (tag lebih kecil) agar tidak bentrok; pihak lain menunggu.
            if (!active || endpointId != null || connecting) return;
            if (!info.getEndpointName().equals(peerTag) || localTag.compareTo(peerTag) >= 0) return;
            client().requestConnection(localTag, id, lifecycle);
        }

        @Override
        public void onEndpointLost(@NonNull String id) {
            // dicari ulang otomatis saat perangkat terlihat lagi
        }
    };

    private void beginSearch(Promise promise) {
        client().startAdvertising(localTag, SERVICE_ID, lifecycle, new AdvertisingOptions.Builder().setStrategy(STRATEGY).build())
            .addOnSuccessListener(unused -> client().startDiscovery(SERVICE_ID, discovery, new DiscoveryOptions.Builder().setStrategy(STRATEGY).build())
                .addOnSuccessListener(u -> {
                    if (promise != null) promise.resolve(null);
                })
                .addOnFailureListener(e -> fail(promise, e)))
            .addOnFailureListener(e -> fail(promise, e));
    }

    private void fail(Promise promise, Exception e) {
        active = false;
        client().stopAllEndpoints();
        emit("state", "error");
        if (promise != null) promise.reject("nearby_failed", e.getMessage() == null ? "Nearby gagal dimulai" : e.getMessage());
    }

    /** Mulai mengumumkan diri dan mencari lawan bicara; local/peer adalah tag turunan, bukan username. */
    @ReactMethod
    public void start(String local, String peer, Promise promise) {
        stopInternal();
        localTag = local;
        peerTag = peer;
        active = true;
        emit("state", "searching");
        try {
            beginSearch(promise);
        } catch (RuntimeException e) {
            fail(promise, e);
        }
    }

    @ReactMethod
    public void send(String json, Promise promise) {
        if (endpointId == null) {
            promise.reject("not_connected", "Belum tersambung");
            return;
        }
        byte[] bytes = json.getBytes(StandardCharsets.UTF_8);
        if (bytes.length > ConnectionsClient.MAX_BYTES_DATA_SIZE) {
            promise.reject("too_large", "Pesan terlalu besar untuk Mode Dekat");
            return;
        }
        client().sendPayload(endpointId, Payload.fromBytes(bytes))
            .addOnSuccessListener(unused -> promise.resolve(null))
            .addOnFailureListener(e -> promise.reject("send_failed", e.getMessage()));
    }

    @ReactMethod
    public void stop(Promise promise) {
        stopInternal();
        emit("state", "off");
        promise.resolve(null);
    }

    private void stopInternal() {
        active = false;
        connecting = false;
        endpointId = null;
        if (client != null) {
            client.stopAdvertising();
            client.stopDiscovery();
            client.stopAllEndpoints();
        }
    }

    @Override
    public void invalidate() {
        stopInternal();
        super.invalidate();
    }

    @ReactMethod
    public void addListener(String eventName) {
        // diperlukan NativeEventEmitter; pendengar dikelola di sisi JS
    }

    @ReactMethod
    public void removeListeners(double count) {
        // diperlukan NativeEventEmitter
    }
}
