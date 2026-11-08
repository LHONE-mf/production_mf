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
import java.security.spec.ECGenParameterSpec;
import java.util.Arrays;

/**
 * Strict device proof bridge. Keys must be non-exportable AndroidKeyStore Ed25519 keys.
 * Unsupported Android providers fail closed: no software-key fallback.
 */
@CapacitorPlugin(name = "DeviceProof")
public class DeviceProofPlugin extends Plugin {
    private static final String ALIAS = "production-mf-device-proof-v1";
    private static final String PREFIX = "production-mf:device-proof:v1:";
    // RFC 8410 SubjectPublicKeyInfo prefix for a 32-byte Ed25519 public key.
    private static final byte[] ED25519_SPKI_PREFIX = new byte[] {
            0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00
    };

    private static boolean isEd25519Spki(byte[] encoded) {
        return encoded != null && encoded.length == 44
                && Arrays.equals(Arrays.copyOf(encoded, ED25519_SPKI_PREFIX.length),
                        ED25519_SPKI_PREFIX);
    }

    private KeyStore store() throws Exception {
        KeyStore store = KeyStore.getInstance("AndroidKeyStore");
        store.load(null);
        return store;
    }

    @PluginMethod
    public void getPublicKey(PluginCall call) {
        try {
            KeyStore store = store();
            if (store.containsAlias(ALIAS)) {
                java.security.cert.Certificate existing = store.getCertificate(ALIAS);
                // Older builds accidentally generated a P-256 key without an explicit Ed25519 curve.
                // Such keys could never pass server enrollment; replace only the invalid alias.
                if (existing == null || !isEd25519Spki(existing.getPublicKey().getEncoded()))
                    store.deleteEntry(ALIAS);
            }
            if (!store.containsAlias(ALIAS)) {
                KeyPairGenerator generator = KeyPairGenerator.getInstance("Ed25519", "AndroidKeyStore");
                generator.initialize(new KeyGenParameterSpec.Builder(
                        ALIAS, KeyProperties.PURPOSE_SIGN | KeyProperties.PURPOSE_VERIFY)
                        .setAlgorithmParameterSpec(new ECGenParameterSpec("ed25519"))
                        .setDigests(KeyProperties.DIGEST_NONE)
                        .build());
                KeyPair generated = generator.generateKeyPair();
                if (generated.getPublic() == null || !isEd25519Spki(generated.getPublic().getEncoded())) {
                    store.deleteEntry(ALIAS);
                    throw new IllegalStateException("Provider generated a non-Ed25519 key");
                }
                if (generated.getPrivate() == null || generated.getPrivate().getEncoded() != null) {
                    store.deleteEntry(ALIAS);
                    throw new IllegalStateException("Private key must be non-exportable");
                }
            }
            java.security.cert.Certificate certificate = store.getCertificate(ALIAS);
            if (certificate == null) throw new IllegalStateException("Ed25519 key unavailable");
            byte[] encoded = certificate.getPublicKey().getEncoded();
            if (!isEd25519Spki(encoded))
                throw new IllegalStateException("Expected Ed25519 SPKI public key");
            String der = Base64.encodeToString(encoded, Base64.NO_WRAP);
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
