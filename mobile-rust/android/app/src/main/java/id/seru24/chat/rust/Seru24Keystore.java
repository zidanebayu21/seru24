package id.seru24.chat.rust;

import android.content.Context;
import android.content.SharedPreferences;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.Base64;

import java.security.KeyStore;
import java.security.SecureRandom;

import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

/**
 * Pembungkus kunci master SQLite vault memakai Android Keystore berbasis perangkat keras
 * (AES-256-GCM), setara penyimpanan aman kunci di Android.
 */
final class Seru24Keystore {
    private static final String KEY_ALIAS = "seru24_rust_vault_master_v1";
    private static final String PREFS = "seru24_rust_keystore";
    private static final String KEY_WRAPPED = "wrapped";
    private static final String KEY_IV = "iv";

    private Seru24Keystore() {}

    private static SecretKey getOrCreateWrappingKey() throws Exception {
        KeyStore ks = KeyStore.getInstance("AndroidKeyStore");
        ks.load(null);
        if (ks.containsAlias(KEY_ALIAS)) {
            return ((KeyStore.SecretKeyEntry) ks.getEntry(KEY_ALIAS, null)).getSecretKey();
        }
        KeyGenerator gen = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore");
        gen.init(new KeyGenParameterSpec.Builder(
                KEY_ALIAS,
                KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT
            )
            .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
            .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
            .setKeySize(256)
            .build());
        return gen.generateKey();
    }

    static synchronized String getOrCreateMasterKey(Context context) {
        try {
            SharedPreferences prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
            String wrappedB64 = prefs.getString(KEY_WRAPPED, null);
            String ivB64 = prefs.getString(KEY_IV, null);
            SecretKey wrapping = getOrCreateWrappingKey();
            if (wrappedB64 != null && ivB64 != null) {
                Cipher dec = Cipher.getInstance("AES/GCM/NoPadding");
                dec.init(Cipher.DECRYPT_MODE, wrapping, new GCMParameterSpec(128, Base64.decode(ivB64, Base64.NO_WRAP)));
                byte[] plain = dec.doFinal(Base64.decode(wrappedB64, Base64.NO_WRAP));
                return Base64.encodeToString(plain, Base64.NO_WRAP);
            }
            byte[] master = new byte[32];
            new SecureRandom().nextBytes(master);
            Cipher enc = Cipher.getInstance("AES/GCM/NoPadding");
            enc.init(Cipher.ENCRYPT_MODE, wrapping);
            byte[] wrapped = enc.doFinal(master);
            prefs.edit()
                .putString(KEY_WRAPPED, Base64.encodeToString(wrapped, Base64.NO_WRAP))
                .putString(KEY_IV, Base64.encodeToString(enc.getIV(), Base64.NO_WRAP))
                .apply();
            return Base64.encodeToString(master, Base64.NO_WRAP);
        } catch (Exception e) {
            return null;
        }
    }
}
