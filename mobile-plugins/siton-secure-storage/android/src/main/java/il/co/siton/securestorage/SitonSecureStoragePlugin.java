package il.co.siton.securestorage;

import android.content.Context;
import android.content.SharedPreferences;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.Base64;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.nio.charset.StandardCharsets;
import java.security.KeyStore;
import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

@CapacitorPlugin(name = "SitonSecureStorage")
public class SitonSecureStoragePlugin extends Plugin {
    private static final String KEY_ALIAS = "il.co.siton.securestorage.v1";
    private static final String STORE_NAME = "siton_secure_storage";
    private static final int MAX_VALUE_BYTES = 65_536;

    private SharedPreferences store() {
        return getContext().getSharedPreferences(STORE_NAME, Context.MODE_PRIVATE);
    }

    private SecretKey secretKey() throws Exception {
        KeyStore keyStore = KeyStore.getInstance("AndroidKeyStore");
        keyStore.load(null);
        if (keyStore.containsAlias(KEY_ALIAS)) return ((KeyStore.SecretKeyEntry) keyStore.getEntry(KEY_ALIAS, null)).getSecretKey();
        KeyGenerator generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore");
        generator.init(new KeyGenParameterSpec.Builder(KEY_ALIAS, KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
            .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
            .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
            .setRandomizedEncryptionRequired(true)
            .build());
        return generator.generateKey();
    }

    private String required(PluginCall call, String name) {
        String value = call.getString(name);
        if (value == null || value.isEmpty()) throw new IllegalArgumentException(name + " is required");
        return value;
    }

    private String requiredKey(PluginCall call) {
        String key = required(call, "key");
        if (!key.matches("^siton_[a-z0-9_]{1,80}$")) throw new IllegalArgumentException("key is invalid");
        return key;
    }

    @PluginMethod
    public void set(PluginCall call) {
        try {
            String key = requiredKey(call);
            String value = required(call, "value");
            if (value.getBytes(StandardCharsets.UTF_8).length > MAX_VALUE_BYTES) throw new IllegalArgumentException("value is too large");
            Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
            cipher.init(Cipher.ENCRYPT_MODE, secretKey());
            byte[] ciphertext = cipher.doFinal(value.getBytes(StandardCharsets.UTF_8));
            String encoded = Base64.encodeToString(cipher.getIV(), Base64.NO_WRAP) + "." + Base64.encodeToString(ciphertext, Base64.NO_WRAP);
            if (!store().edit().putString(key, encoded).commit()) throw new IllegalStateException("secure storage commit failed");
            call.resolve();
        } catch (Exception error) { call.reject("secure_storage_set_failed", null, error); }
    }

    @PluginMethod
    public void get(PluginCall call) {
        try {
            String encoded = store().getString(requiredKey(call), null);
            JSObject result = new JSObject();
            if (encoded == null) { result.put("value", null); call.resolve(result); return; }
            String[] parts = encoded.split("\\.", 2);
            if (parts.length != 2) throw new IllegalStateException("secure storage record invalid");
            Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
            cipher.init(Cipher.DECRYPT_MODE, secretKey(), new GCMParameterSpec(128, Base64.decode(parts[0], Base64.NO_WRAP)));
            byte[] clear = cipher.doFinal(Base64.decode(parts[1], Base64.NO_WRAP));
            result.put("value", new String(clear, StandardCharsets.UTF_8));
            call.resolve(result);
        } catch (Exception error) { call.reject("secure_storage_get_failed", null, error); }
    }

    @PluginMethod
    public void remove(PluginCall call) {
        try {
            if (!store().edit().remove(requiredKey(call)).commit()) throw new IllegalStateException("secure storage remove failed");
            call.resolve();
        } catch (Exception error) { call.reject("secure_storage_remove_failed", null, error); }
    }
}
