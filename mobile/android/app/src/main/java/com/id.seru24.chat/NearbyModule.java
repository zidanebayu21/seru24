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
import com.google.android.gms.nearby.connection.ConnectionOptions;
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
import java.util.HashSet;
import java.util.Set;

/**
 * Siaran Dekat: mengumumkan diri dan mencari HP lain tanpa internet memakai Nearby Connections (BLE untuk menemukan,
 * Bluetooth atau Wi-Fi Direct untuk data). Modul ini hanya mengangkut byte dan melaporkan kejadian ke JS; siapa yang
 * dihubungi, diterima, atau ditolak diputuskan JS. Nama yang diumumkan dibuat JS (alias acak, bukan username). Payload
 * hanya BYTES (maks 32 KB), tanpa file. Jumlah koneksi dibatasi agar perangkat asing tidak bisa membanjiri.
 *
 * Hanya teks pendek yang dikirim, jadi cukup Bluetooth/BLE: mode hemat daya (lowPower) mematikan peningkatan otomatis ke
 * Wi-Fi Direct/hotspot, dan disruptiveUpgrade=false mencegah Wi-Fi HP yang sedang dipakai diputus. Peningkatan ke
 * Wi-Fi itulah yang membuat sambungan sempat putus sehingga pesan gagal terkirim langsung.
 */
public class NearbyModule extends ReactContextBaseJavaModule {
    private static final String EVENT = "seru24NearbyEvent";
    private static final String SERVICE_ID = "id.seru24.chat.radar";
    private static final Strategy STRATEGY = Strategy.P2P_CLUSTER;
    private static final int MAX_LINKS = 6;

    private ConnectionsClient client;
    private boolean active;
    private String localName;
    private final Set<String> connected = new HashSet<>();
    private final Set<String> pending = new HashSet<>();

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

    private void emit(String type, String id, String value) {
        WritableMap map = Arguments.createMap();
        map.putString("type", type);
        map.putString("id", id);
        map.putString("value", value);
        try {
            getReactApplicationContext().getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter.class).emit(EVENT, map);
        } catch (RuntimeException ignored) {
            // JS belum siap atau sedang dimuat ulang: kejadian berikutnya akan menyusul
        }
    }

    private final PayloadCallback payloadCallback = new PayloadCallback() {
        @Override
        public void onPayloadReceived(@NonNull String id, @NonNull Payload payload) {
            byte[] bytes = payload.asBytes();
            if (!connected.contains(id) || payload.getType() != Payload.Type.BYTES || bytes == null) return;
            emit("payload", id, new String(bytes, StandardCharsets.UTF_8));
        }

        @Override
        public void onPayloadTransferUpdate(@NonNull String id, @NonNull PayloadTransferUpdate update) {
            // payload kecil (BYTES) selalu tiba utuh; tidak ada progres untuk dilacak
        }
    };

    private final ConnectionLifecycleCallback lifecycle = new ConnectionLifecycleCallback() {
        @Override
        public void onConnectionInitiated(@NonNull String id, @NonNull ConnectionInfo info) {
            if (!active || connected.size() + pending.size() >= MAX_LINKS) {
                client().rejectConnection(id);
                return;
            }
            pending.add(id);
            // JS memutuskan terima atau tolak (acceptEndpoint / rejectEndpoint)
            emit("incoming", id, info.getEndpointName() + "\n" + info.getAuthenticationDigits());
        }

        @Override
        public void onConnectionResult(@NonNull String id, @NonNull ConnectionResolution result) {
            pending.remove(id);
            if (active && result.getStatus().isSuccess()) {
                connected.add(id);
                emit("connected", id, "");
            } else {
                emit("failed", id, "");
            }
        }

        @Override
        public void onDisconnected(@NonNull String id) {
            pending.remove(id);
            if (connected.remove(id)) emit("disconnected", id, "");
        }
    };

    private final EndpointDiscoveryCallback discovery = new EndpointDiscoveryCallback() {
        @Override
        public void onEndpointFound(@NonNull String id, @NonNull DiscoveredEndpointInfo info) {
            emit("found", id, info.getEndpointName());
        }

        @Override
        public void onEndpointLost(@NonNull String id) {
            emit("lost", id, "");
        }
    };

    /** Mulai mengumumkan nama (dibuat JS) dan mencari perangkat lain. */
    @ReactMethod
    public void start(String name, Promise promise) {
        stopInternal();
        localName = name;
        active = true;
        try {
            client().startAdvertising(localName, SERVICE_ID, lifecycle, new AdvertisingOptions.Builder().setStrategy(STRATEGY).setLowPower(true).setDisruptiveUpgrade(false).build())
                .addOnSuccessListener(unused -> client().startDiscovery(SERVICE_ID, discovery, new DiscoveryOptions.Builder().setStrategy(STRATEGY).setLowPower(true).build())
                    .addOnSuccessListener(u -> {
                        emit("state", "", "on");
                        promise.resolve(null);
                    })
                    .addOnFailureListener(e -> fail(promise, e)))
                .addOnFailureListener(e -> fail(promise, e));
        } catch (RuntimeException e) {
            fail(promise, e);
        }
    }

    private void fail(Promise promise, Exception e) {
        stopInternal();
        emit("state", "", "error");
        promise.reject("nearby_failed", e.getMessage() == null ? "Nearby gagal dimulai" : e.getMessage());
    }

    @ReactMethod
    public void request(String endpointId, Promise promise) {
        if (!active || connected.size() + pending.size() >= MAX_LINKS) {
            promise.reject("busy", "Terlalu banyak koneksi");
            return;
        }
        pending.add(endpointId);
        client().requestConnection(localName, endpointId, lifecycle, new ConnectionOptions.Builder().setLowPower(true).setDisruptiveUpgrade(false).build())
            .addOnSuccessListener(unused -> promise.resolve(null))
            .addOnFailureListener(e -> {
                pending.remove(endpointId);
                promise.reject("request_failed", e.getMessage());
            });
    }

    @ReactMethod
    public void acceptEndpoint(String endpointId) {
        client().acceptConnection(endpointId, payloadCallback);
    }

    @ReactMethod
    public void rejectEndpoint(String endpointId) {
        pending.remove(endpointId);
        client().rejectConnection(endpointId);
    }

    @ReactMethod
    public void disconnect(String endpointId) {
        pending.remove(endpointId);
        connected.remove(endpointId);
        client().disconnectFromEndpoint(endpointId);
    }

    @ReactMethod
    public void send(String endpointId, String json, Promise promise) {
        if (!connected.contains(endpointId)) {
            promise.reject("not_connected", "Belum tersambung");
            return;
        }
        byte[] bytes = json.getBytes(StandardCharsets.UTF_8);
        if (bytes.length > ConnectionsClient.MAX_BYTES_DATA_SIZE) {
            promise.reject("too_large", "Pesan terlalu besar untuk Siaran Dekat");
            return;
        }
        client().sendPayload(endpointId, Payload.fromBytes(bytes))
            .addOnSuccessListener(unused -> promise.resolve(null))
            .addOnFailureListener(e -> promise.reject("send_failed", e.getMessage()));
    }

    @ReactMethod
    public void stop(Promise promise) {
        stopInternal();
        emit("state", "", "off");
        promise.resolve(null);
    }

    private void stopInternal() {
        active = false;
        connected.clear();
        pending.clear();
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
