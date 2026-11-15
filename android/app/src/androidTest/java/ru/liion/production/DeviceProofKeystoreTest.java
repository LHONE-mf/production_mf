package ru.liion.production;

import static org.junit.Assert.assertArrayEquals;
import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertTrue;

import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.Base64;
import android.util.Log;

import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;

import org.junit.Test;
import org.junit.runner.RunWith;

import java.nio.charset.StandardCharsets;
import java.security.KeyPair;
import java.security.KeyPairGenerator;
import java.security.KeyStore;
import java.security.Signature;
import java.security.spec.ECGenParameterSpec;
import java.util.Arrays;

/** Produces a test-only AndroidKeyStore Ed25519 challenge signature for server-side CI verification. */
@RunWith(AndroidJUnit4.class)
public class DeviceProofKeystoreTest {
    @Test
    public void generatesNonExportableEd25519KeyAndSignsChallenge() throws Exception {
        String alias = "production-mf-ed25519-instrumentation";
        String challenge = InstrumentationRegistry.getArguments().getString("proofChallenge", "A".repeat(43));
        assertTrue("test challenge must be canonical base64url", challenge.matches("[A-Za-z0-9_-]{43}"));
        KeyStore store = KeyStore.getInstance("AndroidKeyStore");
        store.load(null);
        // Reuse this TEST-ONLY alias for the second instrumentation invocation.
        // CI obtains a fresh challenge between invocations; the same enrolled
        // public key must match the AndroidKeyStore private key used to sign.
        if (!store.containsAlias(alias)) {
            KeyPairGenerator generator = KeyPairGenerator.getInstance("Ed25519", "AndroidKeyStore");
            generator.initialize(new KeyGenParameterSpec.Builder(
                    alias, KeyProperties.PURPOSE_SIGN | KeyProperties.PURPOSE_VERIFY)
                    .setAlgorithmParameterSpec(new ECGenParameterSpec("ed25519"))
                    .setDigests(KeyProperties.DIGEST_NONE).build());
            KeyPair generated = generator.generateKeyPair();
            assertTrue("private key must not be exportable", generated.getPrivate().getEncoded() == null);
        }
        java.security.PrivateKey privateKey = (java.security.PrivateKey) store.getKey(alias, null);
        assertTrue("private key unavailable", privateKey != null);
        assertTrue("private key must not be exportable", privateKey.getEncoded() == null);
        java.security.cert.Certificate certificate = store.getCertificate(alias);
        assertTrue("public certificate unavailable", certificate != null);
        byte[] spki = certificate.getPublicKey().getEncoded();
        byte[] prefix = new byte[] { 0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00 };
        assertEquals("AndroidKeyStore returned unexpected public key format (algorithm=" + certificate.getPublicKey().getAlgorithm() + ", SPKI length=" + spki.length + ")", 44, spki.length);
        assertArrayEquals(prefix, Arrays.copyOf(spki, prefix.length));
        byte[] message = ("production-mf:device-proof:v1:" + challenge)
                    .getBytes(StandardCharsets.UTF_8);
        Signature signer = Signature.getInstance("Ed25519");
        signer.initSign(privateKey);
        signer.update(message);
        byte[] signature = signer.sign();
        assertEquals(64, signature.length);
        // AndroidKeyStore public keys are provider-specific, and Android does not
        // guarantee a separate Ed25519 verification provider. Emit a TEST-ONLY
        // vector; CI verifies it using Node crypto, as the Fastify server does.
        // This alias is never a production enrolled key.
        Log.i("ProductionMfEd25519", "VECTOR spki="
                + Base64.encodeToString(spki, Base64.URL_SAFE | Base64.NO_WRAP | Base64.NO_PADDING)
                + " signature="
                    + Base64.encodeToString(signature, Base64.URL_SAFE | Base64.NO_WRAP | Base64.NO_PADDING));
        // CI discards the entire emulator after verification; no test key
        // or challenge is used for actual app enrollment.
    }
}
