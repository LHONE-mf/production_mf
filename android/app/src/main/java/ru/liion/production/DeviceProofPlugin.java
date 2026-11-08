package ru.liion.production;

import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.Base64;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.nio.charset.StandardCharsets;
import java.security.KeyPair;
import java.security.KeyPairGenerator;
import java.security.KeyStore;
import java.security.PrivateKey;
import java.security.Signature;

/**
 * Strict device proof bridge. Keys must be non-exportable AndroidKeyStore Ed25519 keys.
 * Unsupported Android providers fail closed: no software-key fallback.
 */
@CapacitorPlugin(name = "DeviceProof")
public class DeviceProofPlugin extends Plugin {
    private static final String ALIAS = "production-mf-device-proof-v1";
    private static final String PREFIX = "production-mf:device-proof:v1:";

    private KeyStore store() throws Exception {
        KeyStore store = KeyStore.getInstance("AndroidKeyStore");
        store.load(null);
        return store;
    }

    @PluginMethod
    public void getPublicKey(PluginCall call) {
        try {
            KeyStore store = store();
            if (!store.containsAlias(ALIAS)) {
                KeyPairGenerator generator = KeyPairGenerator.getInstance("Ed25519", "AndroidKeyStore");
                generator.initialize(new KeyGenParameterSpec.Builder(
                        ALIAS, KeyProperties.PURPOSE_SIGN | KeyProperties.PURPOSE_VERIFY)
                        .setDigests(KeyProperties.DIGEST_NONE)
                        .build());
                KeyPair generated = generator.generateKeyPair();
                if (generated.getPublic() == null) throw new IllegalStateException("Missing public key");
            }
            java.security.cert.Certificate certificate = store.getCertificate(ALIAS);
            if (certificate == null || !"Ed25519".equalsIgnoreCase(certificate.getPublicKey().getAlgorithm()))
                throw new IllegalStateException("Ed25519 key unavailable");
            String der = Base64.encodeToString(certificate.getPublicKey().getEncoded(), Base64.NO_WRAP);
            StringBuilder pem = new StringBuilder("-----BEGIN PUBLIC KEY-----\n");
            for (int i = 0; i < der.length(); i += 64) pem.append(der, i, Math.min(i + 64, der.length())).append('\n');
            pem.append("-----END PUBLIC KEY-----\n");
            JSObject result = new JSObject();
            result.put("publicKey", pem.toString());
            call.resolve(result);
        } catch (Exception error) {
            call.reject("ANDROID_KEYSTORE_ED25519_UNAVAILABLE", error);
        }
    }

    @PluginMethod
    public void signChallenge(PluginCall call) {
        String challenge = call.getString("challenge");
        if (challenge == null || !challenge.matches("[A-Za-z0-9_-]{43}")) {
            call.reject("INVALID_CHALLENGE");
            return;
        }
        try {
            KeyStore store = store();
            PrivateKey key = (PrivateKey) store.getKey(ALIAS, null);
            if (key == null) throw new IllegalStateException("Device key not enrolled");
            Signature signer = Signature.getInstance("Ed25519");
            signer.initSign(key);
            signer.update((PREFIX + challenge).getBytes(StandardCharsets.UTF_8));
            byte[] signature = signer.sign();
            if (signature.length != 64) throw new IllegalStateException("Unexpected signature length");
            JSObject result = new JSObject();
            result.put("signature", Base64.encodeToString(signature,
                    Base64.URL_SAFE | Base64.NO_WRAP | Base64.NO_PADDING));
            call.resolve(result);
        } catch (Exception error) {
            call.reject("DEVICE_SIGNING_UNAVAILABLE", error);
        }
    }
}
