package id.seru24.chat.rust;

import android.app.Activity;
import android.app.NativeActivity;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Bundle;
import android.provider.Settings;

import androidx.annotation.NonNull;
import androidx.core.content.ContextCompat;

import java.lang.ref.WeakReference;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Deque;
import java.util.List;

/**
 * Host NativeActivity untuk Slint UI; meneruskan hasil pemilihan file, izin runtime,
 * dan status foreground ke modul-modul native Rust.
 */
public class Seru24Activity extends NativeActivity {
    public interface ActivityResultHandler {
        void onResult(int resultCode, Intent data);
    }

    public interface PermissionResultHandler {
        void onResult(boolean granted);
    }

    private static final class PermissionRequest {
        final String[] required;
        final String[] anyOf;
        final PermissionResultHandler handler;

        PermissionRequest(String[] required, String[] anyOf, PermissionResultHandler handler) {
            this.required = required;
            this.anyOf = anyOf;
            this.handler = handler;
        }
    }

    private static WeakReference<Seru24Activity> current = new WeakReference<>(null);
    private static ActivityResultHandler pendingFileHandler;
    private static final Object PERMISSION_LOCK = new Object();
    // Android hanya melayani satu dialog izin sekaligus: permintaan kedua yang datang saat dialog masih tampil langsung
    // dibatalkan sistem, jadi permintaan diantrekan dan dijalankan satu per satu.
    private static final Deque<PermissionRequest> permissionQueue = new ArrayDeque<>();
    private static PermissionRequest permissionInFlight;
    private static volatile boolean lastDeniedForever;
    private static final int REQ_PICK_FILES = 4243;
    private static final int REQ_PERMISSIONS = 4244;

    public static Activity currentActivity() {
        return current.get();
    }

    public static boolean launchFilePicker(ActivityResultHandler handler) {
        Seru24Activity act = current.get();
        if (act == null) {
            return false;
        }
        pendingFileHandler = handler;
        Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT)
            .addCategory(Intent.CATEGORY_OPENABLE)
            .setType("*/*")
            .putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true);
        act.runOnUiThread(() -> {
            try {
                act.startActivityForResult(intent, REQ_PICK_FILES);
            } catch (Exception e) {
                pendingFileHandler = null;
            }
        });
        return true;
    }

    /** Semua izin di {@code permissions} wajib diberikan. */
    public static void ensurePermissions(String[] permissions, PermissionResultHandler handler) {
        ensurePermissions(permissions, new String[0], handler);
    }

    /**
     * Semua izin di {@code required} wajib diberikan, dan bila {@code anyOf} tidak kosong minimal satu darinya
     * (mis. lokasi tepat atau perkiraan: sejak Android 12 pengguna boleh memilih "perkiraan", dan keduanya harus
     * diminta bersama dalam satu dialog atau permintaan diabaikan sistem).
     */
    public static void ensurePermissions(String[] required, String[] anyOf, PermissionResultHandler handler) {
        Seru24Activity act = current.get();
        if (act == null) {
            handler.onResult(false);
            return;
        }
        PermissionRequest req = new PermissionRequest(required, anyOf, handler);
        if (isSatisfied(act, req)) {
            handler.onResult(true);
            return;
        }
        synchronized (PERMISSION_LOCK) {
            permissionQueue.add(req);
        }
        act.runOnUiThread(Seru24Activity::pumpPermissionQueue);
    }

    /** True bila pengguna menolak dengan "Jangan tanya lagi"; dialog tidak akan muncul lagi, arahkan ke Pengaturan. */
    public static boolean wasDeniedForever() {
        return lastDeniedForever;
    }

    public static void openAppSettings() {
        Seru24Activity act = current.get();
        if (act == null) {
            return;
        }
        Intent intent = new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:" + act.getPackageName()));
        act.runOnUiThread(() -> {
            try {
                act.startActivity(intent);
            } catch (Exception ignored) {
                // Layar pengaturan tidak tersedia di perangkat ini.
            }
        });
    }

    private static boolean isGranted(Activity act, String permission) {
        return ContextCompat.checkSelfPermission(act, permission) == PackageManager.PERMISSION_GRANTED;
    }

    private static boolean isSatisfied(Activity act, PermissionRequest req) {
        for (String perm : req.required) {
            if (!isGranted(act, perm)) {
                return false;
            }
        }
        if (req.anyOf.length == 0) {
            return true;
        }
        for (String perm : req.anyOf) {
            if (isGranted(act, perm)) {
                return true;
            }
        }
        return false;
    }

    private static String[] missingPermissions(Activity act, PermissionRequest req) {
        List<String> missing = new ArrayList<>();
        for (String perm : req.required) {
            if (!isGranted(act, perm)) {
                missing.add(perm);
            }
        }
        boolean anyGranted = req.anyOf.length == 0;
        for (String perm : req.anyOf) {
            anyGranted |= isGranted(act, perm);
        }
        if (!anyGranted) {
            for (String perm : req.anyOf) {
                missing.add(perm);
            }
        }
        return missing.toArray(new String[0]);
    }

    /** Dijalankan di thread UI: mulai permintaan berikutnya bila tidak ada dialog yang sedang tampil. */
    private static void pumpPermissionQueue() {
        Seru24Activity act = current.get();
        PermissionRequest req;
        synchronized (PERMISSION_LOCK) {
            if (permissionInFlight != null || permissionQueue.isEmpty()) {
                return;
            }
            req = permissionQueue.poll();
            permissionInFlight = req;
        }
        if (act == null || isSatisfied(act, req)) {
            finishPermissionRequest(req, act != null);
            return;
        }
        act.requestPermissions(missingPermissions(act, req), REQ_PERMISSIONS);
    }

    private static void finishPermissionRequest(PermissionRequest req, boolean granted) {
        synchronized (PERMISSION_LOCK) {
            permissionInFlight = null;
        }
        req.handler.onResult(granted);
        pumpPermissionQueue();
    }

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        current = new WeakReference<>(this);
    }

    @Override
    protected void onResume() {
        super.onResume();
        current = new WeakReference<>(this);
        Seru24Notifications.setAppForeground(true);
    }

    @Override
    protected void onPause() {
        Seru24Notifications.setAppForeground(false);
        super.onPause();
    }

    @Override
    protected void onDestroy() {
        if (current.get() == this) {
            current = new WeakReference<>(null);
        }
        super.onDestroy();
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        if (requestCode == REQ_PICK_FILES && pendingFileHandler != null) {
            ActivityResultHandler h = pendingFileHandler;
            pendingFileHandler = null;
            h.onResult(resultCode, data);
            return;
        }
        super.onActivityResult(requestCode, resultCode, data);
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, @NonNull String[] permissions, @NonNull int[] grantResults) {
        PermissionRequest req;
        synchronized (PERMISSION_LOCK) {
            req = requestCode == REQ_PERMISSIONS ? permissionInFlight : null;
        }
        if (req == null) {
            super.onRequestPermissionsResult(requestCode, permissions, grantResults);
            return;
        }
        // Status akhir dibaca dari sistem (bukan hanya grantResults) agar izin yang sudah diberikan sebelumnya ikut dihitung.
        boolean deniedForever = false;
        for (String perm : permissions) {
            if (!isGranted(this, perm) && !shouldShowRequestPermissionRationale(perm)) {
                deniedForever = true;
            }
        }
        boolean granted = isSatisfied(this, req);
        lastDeniedForever = !granted && deniedForever;
        finishPermissionRequest(req, granted);
    }
}
