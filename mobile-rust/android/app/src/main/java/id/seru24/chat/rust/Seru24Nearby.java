package id.seru24.chat.rust;

import android.Manifest;
import android.content.Context;
import android.os.Build;

import androidx.annotation.NonNull;

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
import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Set;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;

/**
 * Siaran Dekat tanpa internet melalui Google Play Services Nearby Connections (mode P2P_CLUSTER).
 */
final class Seru24Nearby {
    private static final String SERVICE_ID = "id.seru24.chat.radar";
    private static final int MAX_LINKS = 6;

    private static ConnectionsClient client;
    private static volatile boolean active;
    private static String localName = "";
    private static final Set<String> connected = new HashSet<>();
    private static final Set<String> pending = new HashSet<>();

    private Seru24Nearby() {}

    private static synchronized ConnectionsClient client(Context context) {
        if (client == null) client = Nearby.getConnectionsClient(context.getApplicationContext());
        return client;
    }

    private static final PayloadCallback payloadCallback = new PayloadCallback() {
        @Override
        public void onPayloadReceived(@NonNull String id, @NonNull Payload payload) {
            byte[] bytes = payload.asBytes();
            if (!connected.contains(id) || payload.getType() != Payload.Type.BYTES || bytes == null) return;
            NativeBridge.onNearbyEvent("payload", id, new String(bytes, StandardCharsets.UTF_8));
        }

        @Override
        public void onPayloadTransferUpdate(@NonNull String id, @NonNull PayloadTransferUpdate update) {}
    };

    private static final ConnectionLifecycleCallback lifecycle = new ConnectionLifecycleCallback() {
        @Override
        public void onConnectionInitiated(@NonNull String id, @NonNull ConnectionInfo info) {
            if (!active || connected.size() + pending.size() >= MAX_LINKS) {
                if (client != null) client.rejectConnection(id);
                return;
            }
            pending.add(id);
            NativeBridge.onNearbyEvent("incoming", id, info.getEndpointName() + "\n" + info.getAuthenticationDigits());
        }

        @Override
        public void onConnectionResult(@NonNull String id, @NonNull ConnectionResolution result) {
            pending.remove(id);
            if (active && result.getStatus().isSuccess()) {
                connected.add(id);
                NativeBridge.onNearbyEvent("connected", id, "");
            } else {
                NativeBridge.onNearbyEvent("failed", id, "");
            }
        }

        @Override
        public void onDisconnected(@NonNull String id) {
            pending.remove(id);
            if (connected.remove(id)) {
                NativeBridge.onNearbyEvent("disconnected", id, "");
            }
        }
    };

    private static final EndpointDiscoveryCallback discovery = new EndpointDiscoveryCallback() {
        @Override
        public void onEndpointFound(@NonNull String id, @NonNull DiscoveredEndpointInfo info) {
            NativeBridge.onNearbyEvent("found", id, info.getEndpointName());
        }

        @Override
        public void onEndpointLost(@NonNull String id) {
            NativeBridge.onNearbyEvent("disconnected", id, "");
        }
    };

    /** Izin wajib menurut versi Android: Bluetooth sejak 12 (API 31), Wi-Fi sekitar sejak 13 (API 33). */
    private static String[] requiredPermissions() {
        List<String> perms = new ArrayList<>();
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            perms.add(Manifest.permission.BLUETOOTH_ADVERTISE);
            perms.add(Manifest.permission.BLUETOOTH_CONNECT);
            perms.add(Manifest.permission.BLUETOOTH_SCAN);
        }
        if (Build.VERSION.SDK_INT >= 33) {
            perms.add(Manifest.permission.NEARBY_WIFI_DEVICES);
        }
        return perms.toArray(new String[0]);
    }

    /** Google Play Services butuh lokasi di semua versi; lokasi perkiraan atau tepat sama-sama cukup. */
    private static String[] locationPermissions() {
        return new String[]{Manifest.permission.ACCESS_FINE_LOCATION, Manifest.permission.ACCESS_COARSE_LOCATION};
    }

    static String start(Context context, String endpointName) {
        CountDownLatch permLatch = new CountDownLatch(1);
        AtomicBoolean permOk = new AtomicBoolean(false);
        Seru24Activity.ensurePermissions(requiredPermissions(), locationPermissions(), granted -> {
            permOk.set(granted);
            permLatch.countDown();
        });
        try {
            permLatch.await(120, TimeUnit.SECONDS);
        } catch (InterruptedException ignored) {
            Thread.currentThread().interrupt();
        }
        if (!permOk.get()) {
            if (Seru24Activity.wasDeniedForever()) {
                Seru24Activity.openAppSettings();
                return "Izin Perangkat di sekitar dan Lokasi ditolak permanen: aktifkan di Pengaturan > Izin, lalu coba lagi";
            }
            return "Siaran Dekat butuh izin Perangkat di sekitar dan Lokasi";
        }

        stop(context);
        localName = endpointName == null ? "" : endpointName;
        active = true;
        try {
            ConnectionsClient c = client(context);
            c.startAdvertising(
                    localName,
                    SERVICE_ID,
                    lifecycle,
                    new AdvertisingOptions.Builder()
                        .setStrategy(Strategy.P2P_CLUSTER)
                        .setLowPower(true)
                        .setDisruptiveUpgrade(false)
                        .build()
                )
                .addOnSuccessListener(u -> c.startDiscovery(
                    SERVICE_ID,
                    discovery,
                    new DiscoveryOptions.Builder().setStrategy(Strategy.P2P_CLUSTER).setLowPower(true).build()
                ))
                .addOnFailureListener(e -> {
                    active = false;
                    NativeBridge.onNearbyEvent("error", "", e.getMessage() == null ? "Nearby gagal" : e.getMessage());
                });
            return "";
        } catch (Exception e) {
            active = false;
            return e.getMessage() == null ? "Siaran Dekat gagal dimulai" : e.getMessage();
        }
    }

    static void stop(Context context) {
        active = false;
        connected.clear();
        pending.clear();
        if (client != null) {
            client.stopAdvertising();
            client.stopDiscovery();
            client.stopAllEndpoints();
        }
    }

    static void request(Context context, String endpointId, String localEndpointName) {
        if (!active || connected.size() + pending.size() >= MAX_LINKS) return;
        pending.add(endpointId);
        client(context).requestConnection(
            localEndpointName == null ? localName : localEndpointName,
            endpointId,
            lifecycle,
            new ConnectionOptions.Builder().setLowPower(true).setDisruptiveUpgrade(false).build()
        ).addOnFailureListener(e -> pending.remove(endpointId));
    }

    static void accept(Context context, String endpointId) {
        client(context).acceptConnection(endpointId, payloadCallback);
    }

    static void reject(Context context, String endpointId) {
        pending.remove(endpointId);
        client(context).rejectConnection(endpointId);
    }

    static void send(Context context, String endpointId, String payload) {
        if (!connected.contains(endpointId) || payload == null) return;
        byte[] bytes = payload.getBytes(StandardCharsets.UTF_8);
        if (bytes.length > ConnectionsClient.MAX_BYTES_DATA_SIZE) return;
        client(context).sendPayload(endpointId, Payload.fromBytes(bytes));
    }
}
