package ru.liion.production;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import android.app.Instrumentation;
import android.content.Intent;
import android.util.Base64;
import android.util.Log;
import android.webkit.WebView;

import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;

import org.json.JSONObject;
import org.json.JSONTokener;
import org.junit.Test;
import org.junit.runner.RunWith;

import java.security.KeyStore;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;

/**
 * Exercises the actual registered Capacitor DeviceProof plugin through the app WebView.
 * Only disposable emulator keys and signatures are emitted for CI verification.
 */
@RunWith(AndroidJUnit4.class)
public class DeviceProofCapacitorPluginTest {
    private static final String RESULT = "window.__productionMfPluginProofResult";
    private static final String ALIAS = "production-mf-device-proof-v1";

    private static String eval(Instrumentation instrumentation, WebView view, String javascript) throws Exception {
        CountDownLatch done = new CountDownLatch(1);
        AtomicReference<String> value = new AtomicReference<>();
        instrumentation.runOnMainSync(() ->
                view.evaluateJavascript(javascript, result -> {
                    value.set(result);
                    done.countDown();
                }));
        assertTrue("WebView JavaScript callback timed out", done.await(15, TimeUnit.SECONDS));
        return value.get();
    }

    @Test
    public void bridgeSignsChallengeWithNonExportableDeviceKey() throws Exception {
        String challenge = InstrumentationRegistry.getArguments().getString("proofChallenge", "A".repeat(43));
        assertTrue("Expected canonical 32-byte challenge", challenge.matches("[A-Za-z0-9_-]{43}"));

        Instrumentation instrumentation = InstrumentationRegistry.getInstrumentation();
        Intent intent = new Intent(instrumentation.getTargetContext(), MainActivity.class);
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TASK);
        MainActivity activity = (MainActivity) instrumentation.startActivitySync(intent);
        try {
            WebView webView = activity.getBridge().getWebView();
            assertNotNull("Capacitor WebView unavailable", webView);

            boolean ready = false;
            for (int i = 0; i < 120; i++) {
                if ("true".equals(eval(instrumentation, webView,
                        "Boolean(window.Capacitor && typeof window.Capacitor.nativePromise === 'function')"))) {
                    ready = true;
                    break;
                }
                Thread.sleep(250);
            }
            assertTrue("Capacitor native bridge never became ready", ready);

            String script = RESULT + " = null; (async function () { try {"
                    + "const bridge = window.Capacitor;"
                    + "const key = await bridge.nativePromise('DeviceProof', 'getPublicKey', {});"
                    + "const signed = await bridge.nativePromise('DeviceProof', 'signChallenge',"
                    + "{ challenge: " + JSONObject.quote(challenge) + " });"
                    + "let invalidRejected = false;"
                    + "try { await bridge.nativePromise('DeviceProof', 'signChallenge', { challenge: 'bad' }); }"
                    + "catch (_) { invalidRejected = true; }"
                    + RESULT + " = JSON.stringify({ publicKey: key.publicKey,"
                    + "signature: signed.signature, invalidRejected });"
                    + "} catch (error) { " + RESULT + " = JSON.stringify({ error: String(error) }); }"
                    + "})();";
            eval(instrumentation, webView, script);

            JSONObject output = null;
            for (int i = 0; i < 120; i++) {
                String serialized = eval(instrumentation, webView, RESULT);
                Object parsed = new JSONTokener(serialized).nextValue();
                if (parsed instanceof String) {
                    output = new JSONObject((String) parsed);
                    break;
                }
                Thread.sleep(250);
            }
            assertNotNull("Capacitor plugin call timed out", output);
            assertFalse("Native plugin call failed: " + output, output.has("error"));
            assertTrue("Native bridge accepted malformed challenge", output.getBoolean("invalidRejected"));

            String pem = output.getString("publicKey");
            assertTrue(pem.startsWith("-----BEGIN PUBLIC KEY-----"));
            byte[] spki = Base64.decode(pem.replace("-----BEGIN PUBLIC KEY-----", "")
                    .replace("-----END PUBLIC KEY-----", "").replaceAll("\\s+", ""), Base64.DEFAULT);
            assertEquals("Expected Ed25519 RFC8410 SPKI", 44, spki.length);
            String signature = output.getString("signature");
            assertTrue(signature.matches("[A-Za-z0-9_-]{86}"));
            assertEquals(64, Base64.decode(signature, Base64.URL_SAFE | Base64.NO_WRAP | Base64.NO_PADDING).length);

            KeyStore keyStore = KeyStore.getInstance("AndroidKeyStore");
            keyStore.load(null);
            assertNotNull("DeviceProof key missing from AndroidKeyStore", keyStore.getKey(ALIAS, null));
            assertNull("DeviceProof private key must not be exportable", keyStore.getKey(ALIAS, null).getEncoded());

            Log.i("ProductionMfCapacitor", "VECTOR spki="
                    + Base64.encodeToString(spki, Base64.URL_SAFE | Base64.NO_WRAP | Base64.NO_PADDING)
                    + " signature=" + signature);
        } finally {
            instrumentation.runOnMainSync(activity::finish);
        }
    }
}
