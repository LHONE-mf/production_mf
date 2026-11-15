package ru.liion.production;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertTrue;

import android.app.Instrumentation;
import android.content.Intent;
import android.content.SharedPreferences;
import android.graphics.Bitmap;
import android.util.Base64;
import android.util.Log;
import android.webkit.WebView;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import org.json.JSONObject;
import org.json.JSONTokener;
import org.junit.Test;
import org.junit.runner.RunWith;
import java.io.File;
import java.io.FileOutputStream;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;

/** Two separate instrumentations around adb force-stop, using only CI debug assets.
 * No fixture credentials or device keys are printed or retained in preferences. */
@RunWith(AndroidJUnit4.class)
public class StorageBackendWebViewTest {
    private static String eval(Instrumentation instrumentation, WebView view, String script) throws Exception {
        CountDownLatch done = new CountDownLatch(1);
        AtomicReference<String> result = new AtomicReference<>();
        instrumentation.runOnMainSync(() -> view.evaluateJavascript(script, value -> {
            result.set(value); done.countDown();
        }));
        assertTrue("JavaScript callback timed out", done.await(15, TimeUnit.SECONDS));
        return result.get();
    }

    private static JSONObject run(Instrumentation instrumentation, WebView view, String action) throws Exception {
        eval(instrumentation, view, "window.__storageResult=null; Promise.resolve().then(async()=>{"
            + action + "}).then(result=>window.__storageResult=JSON.stringify({result}))"
            + ".catch(error=>window.__storageResult=JSON.stringify({error:String(error.message)}));");
        for (int i = 0; i < 720; i++) {
            Object value = new JSONTokener(eval(instrumentation, view, "window.__storageResult")).nextValue();
            if (value instanceof String) {
                JSONObject output = new JSONObject((String) value);
                assertTrue("Storage assertion failed: " + output.optString("error"), !output.has("error"));
                return output.getJSONObject("result");
            }
            Thread.sleep(250);
        }
        throw new AssertionError("Storage backend scenario timed out");
    }

    @Test
    public void storageBackendRoundTrip() throws Exception {
        Instrumentation instrumentation = InstrumentationRegistry.getInstrumentation();
        assertEquals("App must declare network permission for the actual backend",
            android.content.pm.PackageManager.PERMISSION_GRANTED,
            instrumentation.getTargetContext().checkSelfPermission(android.Manifest.permission.INTERNET));
        String phase = InstrumentationRegistry.getArguments().getString("storagePhase", "");
        String encoded = InstrumentationRegistry.getArguments().getString("storageFixture", "");
        assertTrue("Run with disposable fixture and prepare/finish phase", !encoded.isEmpty()
            && (phase.equals("prepare") || phase.equals("finish")));
        JSONObject fixture = new JSONObject(new String(Base64.decode(encoded, Base64.NO_WRAP), java.nio.charset.StandardCharsets.UTF_8));
        assertEquals("http://127.0.0.1:3002", fixture.getString("serverUrl"));
        Intent intent = new Intent(instrumentation.getTargetContext(), MainActivity.class);
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TASK);
        MainActivity activity = (MainActivity) instrumentation.startActivitySync(intent);
        try {
            WebView view = activity.getBridge().getWebView();
            // Let Capacitor's initial document finish before navigating. Its
            // queued startup load must not replace the instrumentation page.
            boolean initialReady = false;
            for (int i = 0; i < 160; i++) {
                if ("true".equals(eval(instrumentation, view,
                        "Boolean(window.Capacitor && document.readyState==='complete' && location.origin==='https://localhost')"))) {
                    initialReady = true; break;
                }
                Thread.sleep(250);
            }
            assertTrue("Initial Capacitor document unavailable", initialReady);
            instrumentation.runOnMainSync(() -> view.loadUrl("https://localhost/tests/android-storage/index.html"));
            boolean ready = false;
            for (int i = 0; i < 160; i++) {
                if ("true".equals(eval(instrumentation, view, "Boolean(window.storageCi && window.Capacitor)"))) {
                    ready = true; break;
                }
                Thread.sleep(250);
            }
            if (!ready) Log.e("ProductionMfStorage", "Harness startup: " + eval(instrumentation, view,
                "JSON.stringify({path:location.pathname,title:document.title,controlled:Boolean(navigator.serviceWorker && navigator.serviceWorker.controller)})"));
            assertTrue("Debug Storage harness unavailable", ready);
            assertTrue(run(instrumentation, view, "return await window.storageCi.connect(" + fixture + ");").getBoolean("connected"));
            SharedPreferences checkpoint = instrumentation.getTargetContext().getSharedPreferences("storage-ci-checkpoint", 0);
            JSONObject result;
            if (phase.equals("prepare")) {
                result = run(instrumentation, view, "return await window.storageCi.prepare();");
                assertEquals(2125000, result.getJSONObject("request").getInt("quantity"));
                assertTrue("Could not persist test checkpoint", checkpoint.edit().putString("intent", result.toString()).commit());
            } else {
                instrumentation.getUiAutomation().grantRuntimePermission(
                    instrumentation.getTargetContext().getPackageName(), android.Manifest.permission.CAMERA);
                String saved = checkpoint.getString("intent", null);
                assertNotNull("Missing frozen intent from the force-stopped process", saved);
                result = run(instrumentation, view, "return await window.storageCi.finish(" + new JSONObject(saved) + ");");
                assertTrue(result.getBoolean("passed"));
                assertEquals(5, result.getInt("containers"));
                assertTrue(result.getBoolean("nativeCellSubmissionApi"));
                assertTrue(result.getBoolean("cellSubmissionLostReplyRetried"));
                assertTrue(result.getBoolean("cellSubmissionNoStock"));
                assertEquals(2, result.getInt("cellSubmissionActualQuantity"));
                assertTrue(result.getBoolean("formationIdentityProcessDeath"));
                assertTrue(result.getBoolean("formationIdentityPreservedSource"));
                assertTrue(result.getBoolean("formationIdentityNoStock"));
                assertEquals(2, result.getInt("formationExplicitProcessed"));
                assertEquals(4, result.getInt("formationFullInput"));
                assertTrue(result.getBoolean("finishedProcessDeath"));
                assertTrue(result.getBoolean("finishedLostReplies"));
                assertTrue(result.getBoolean("finishedSourceHeld"));
                assertEquals(7, result.getInt("finishedActualQuantity"));
                assertTrue(result.getBoolean("nativeProof"));
                assertTrue(result.getBoolean("operatorDenied"));
                assertTrue(result.getBoolean("lostAckRetried"));
                assertTrue(result.getBoolean("logoutConcealed"));
                assertTrue(result.getBoolean("issueProcessDeath"));
                assertTrue(result.getBoolean("chiefIssueApproved"));
                assertTrue(result.getBoolean("issueLostAckRetried"));
                assertTrue(result.getBoolean("assignedReceipt"));
                assertEquals(500000, result.getInt("issuedQuantity"));
                assertTrue(result.getBoolean("directReturnAvailable"));
                assertTrue(result.getBoolean("returnLostAckRetried"));
                assertTrue(result.getBoolean("invalidReturnDenied"));
                assertEquals(200000, result.getInt("returnedQuantity"));
                assertTrue(result.getBoolean("warehouseScrapApproved"));
                assertTrue(result.getBoolean("warehouseScrapOperatorDenied"));
                assertEquals(1000, result.getInt("warehouseScrappedQuantity"));
                assertTrue(result.getBoolean("splitApproved"));
                assertTrue(result.getBoolean("splitOperatorDenied"));
                assertTrue(result.getBoolean("splitLostAckRetried"));
                assertTrue(result.getBoolean("splitChildLabelResolved"));
                assertEquals(125000, result.getInt("splitQuantity"));
                assertTrue(result.getBoolean("countObservedWithoutStock"));
                assertTrue(result.getBoolean("countOperatorCorrectionDenied"));
                assertTrue(result.getBoolean("countChiefCorrection"));
                assertTrue(result.getBoolean("countLostAckRetried"));
                assertEquals(124000, result.getInt("countedQuantity"));
                assertTrue(result.getBoolean("nativeCountHistorySnapshot"));
                assertTrue(result.getBoolean("nativeMovementAudit"));
                assertTrue(result.getBoolean("nativeIssueReconciliation"));
                assertEquals(300000, result.getInt("reconciledOutstanding"));
                assertTrue(result.getBoolean("nativeIdentityLookups"));
                assertTrue(result.getBoolean("nativeOfflineIdentity"));
                assertTrue(result.getBoolean("nativeCameraStreamStopped"));
                assertTrue(result.getBoolean("nativeWrongTenantLabelDenied"));
                // Open the actual Android print spooler using the real UI/plugin.
                // Poll it independently: the WebView may pause while the system
                // print activity owns the foreground, then resume after Back.
                eval(instrumentation, view, "window.__labelPrintResult=null; window.storageCi.printLabel("
                    + JSONObject.quote(result.getString("splitChildId"))
                    + ").then(r=>window.__labelPrintResult=JSON.stringify(r))"
                    + ".catch(e=>window.__labelPrintResult=JSON.stringify({error:String(e)}));");
                boolean printDialog = false;
                for (int i = 0; i < 120; i++) {
                    android.view.accessibility.AccessibilityNodeInfo node = instrumentation.getUiAutomation().getRootInActiveWindow();
                    if (node != null && node.getPackageName() != null
                            && node.getPackageName().toString().contains("printspooler")) { printDialog = true; break; }
                    Thread.sleep(250);
                }
                assertTrue("Actual Android print dialog did not open", printDialog);
                Bitmap labelDialog = instrumentation.getUiAutomation().takeScreenshot();
                assertNotNull(labelDialog);
                try (FileOutputStream output = new FileOutputStream(new File(activity.getExternalFilesDir(null), "storage-label-print-dialog.png"))) {
                    assertTrue(labelDialog.compress(Bitmap.CompressFormat.PNG, 100, output));
                }
                assertTrue(instrumentation.getUiAutomation().performGlobalAction(android.accessibilityservice.AccessibilityService.GLOBAL_ACTION_BACK));
                boolean printReturned = false;
                for (int i = 0; i < 120; i++) {
                    if ("true".equals(eval(instrumentation, view,
                            "Boolean(window.__labelPrintResult && document.body.textContent.includes('Диалог печати открыт'))"))) { printReturned = true; break; }
                    Thread.sleep(250);
                }
                assertTrue("Native label printing did not return to the app", printReturned);
                assertTrue(run(instrumentation, view, "return await window.storageCi.conceal();").getBoolean("concealed"));
                result.put("nativePrintDialogOpened", true);
                Log.i("ProductionMfStorage", "RESULT " + result);
            }
            Bitmap screenshot = instrumentation.getUiAutomation().takeScreenshot();
            assertNotNull("Storage screenshot unavailable", screenshot);
            try (FileOutputStream output = new FileOutputStream(new File(activity.getExternalFilesDir(null), "storage-backend-" + phase + ".png"))) {
                assertTrue(screenshot.compress(Bitmap.CompressFormat.PNG, 100, output));
            } finally { screenshot.recycle(); }
        } finally {
            // Keep the tested screen available for the runner hierarchy dump.
            // The shell runner force-stops this process immediately afterwards.
        }
    }
}
