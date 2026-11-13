package id.seru24.chat;

import android.util.Base64;

import com.facebook.react.bridge.Promise;
import com.facebook.react.bridge.ReactApplicationContext;
import com.facebook.react.bridge.ReactContextBaseJavaModule;
import com.facebook.react.bridge.ReactMethod;

import org.bouncycastle.crypto.generators.SCrypt;

import java.util.Arrays;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * scrypt native (RFC 7914) untuk turunan password di shared/crypto.ts.
 * Hermes tidak punya JIT sehingga scrypt JavaScript butuh puluhan detik; versi Java ini ratusan milidetik.
 * Dijalankan di thread terpisah agar UI tidak membeku. Input/output base64.
 */
public class ScryptModule extends ReactContextBaseJavaModule {
    private static final ExecutorService EXECUTOR = Executors.newSingleThreadExecutor();

    ScryptModule(ReactApplicationContext context) {
        super(context);
    }

    @Override
    public String getName() {
        return "Seru24Scrypt";
    }

    @ReactMethod
    public void derive(String passwordB64, String saltB64, double n, double r, double p, double dkLen, Promise promise) {
        EXECUTOR.execute(() -> {
            byte[] password = Base64.decode(passwordB64, Base64.NO_WRAP);
            byte[] output = null;
            try {
                output = SCrypt.generate(password, Base64.decode(saltB64, Base64.NO_WRAP), (int) n, (int) r, (int) p, (int) dkLen);
                promise.resolve(Base64.encodeToString(output, Base64.NO_WRAP));
            } catch (RuntimeException e) {
                promise.reject("scrypt_failed", e);
            } finally {
                Arrays.fill(password, (byte) 0);
                if (output != null) {
                    Arrays.fill(output, (byte) 0);
                }
            }
        });
    }
}
