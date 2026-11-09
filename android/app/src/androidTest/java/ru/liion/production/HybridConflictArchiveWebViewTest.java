package ru.liion.production;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertTrue;

import android.app.Instrumentation;
import android.content.Intent;
import android.webkit.WebView;

import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;

import org.json.JSONObject;
import org.json.JSONTokener;
import org.junit.Test;
import org.junit.runner.RunWith;

import java.util.UUID;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;

/** Real Android WebView/IndexedDB durability check for Dexie v17 conflict archives.
 * Only isolated CI emulator records are created; the single test record is deleted. */
@RunWith(AndroidJUnit4.class)
public class HybridConflictArchiveWebViewTest {
    private static final String RESULT = "window.__productionMfArchiveProbe";

    private static String eval(Instrumentation instrumentation, WebView view, String script) throws Exception {
        CountDownLatch latch = new CountDownLatch(1);
        AtomicReference<String> result = new AtomicReference<>();
        instrumentation.runOnMainSync(() -> view.evaluateJavascript(script, value -> {
            result.set(value);
            latch.countDown();
        }));
        assertTrue("WebView JavaScript timed out", latch.await(15, TimeUnit.SECONDS));
        return result.get();
    }

    private static MainActivity launch(Instrumentation instrumentation) throws Exception {
        Intent intent = new Intent(instrumentation.getTargetContext(), MainActivity.class);
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TASK);
        MainActivity activity = (MainActivity) instrumentation.startActivitySync(intent);
        assertNotNull(activity.getBridge());
        for (int i = 0; i < 120; i++) {
            if ("true".equals(eval(instrumentation, activity.getBridge().getWebView(),
                    "Boolean(window.Capacitor && window.indexedDB)"))) return activity;
            Thread.sleep(250);
        }
        throw new AssertionError("Production MF WebView was not ready");
    }

    private static JSONObject run(Instrumentation instrumentation, WebView view, String action) throws Exception {
        String script = RESULT + " = null; (async function() {"
                + "const request = indexedDB.open('LiIonProductionDB');"
                + "const db = await new Promise((resolve, reject) => {"
                + " request.onsuccess = () => resolve(request.result);"
                + " request.onerror = () => reject(request.error);"
                + "});"
                + "try {"
                + " if (!db.objectStoreNames.contains('hybridTaskResolutions'))"
                + " throw Error('Missing Dexie v17 archive store');"
                + action
                + "} finally { db.close(); }"
                + "})().then(value => { " + RESULT + " = JSON.stringify({value}); })"
                + ".catch(error => { " + RESULT + " = JSON.stringify({error:String(error)}); });";
        eval(instrumentation, view, script);
        for (int i = 0; i < 120; i++) {
            Object result = new JSONTokener(eval(instrumentation, view, RESULT)).nextValue();
            if (result instanceof String) {
                JSONObject parsed = new JSONObject((String) result);
                assertTrue("IndexedDB archive probe failed: " + parsed, !parsed.has("error"));
                return parsed;
            }
            Thread.sleep(250);
        }
        throw new AssertionError("IndexedDB archive probe timed out");
    }

    @Test
    public void conflictArchiveSurvivesActivityRestart() throws Exception {
        Instrumentation instrumentation = InstrumentationRegistry.getInstrumentation();
        String archiveId = UUID.randomUUID().toString();
        String entityId = UUID.randomUUID().toString();
        MainActivity first = launch(instrumentation);
        try {
            // Ensure production app has opened its Dexie schema before the probe.
            Thread.sleep(1200);
            JSONObject inserted = run(instrumentation, first.getBridge().getWebView(),
                    "const tx = db.transaction('hybridTaskResolutions', 'readwrite');"
                    + "tx.objectStore('hybridTaskResolutions').put({"
                    + "id:" + JSONObject.quote(archiveId) + ","
                    + "entityId:" + JSONObject.quote(entityId) + ","
                    + "archivedAt:Date.now(),decision:'use_server',"
                    + "localTask:{title:'CI offline edit'},localOperations:[{operationId:'ci-test'}],"
                    + "serverRevision:2,serverPayload:{title:'CI remote edit'}});"
                    + "await new Promise((resolve,reject) => {"
                    + "tx.oncomplete=resolve;tx.onerror=()=>reject(tx.error);"
                    + "tx.onabort=()=>reject(tx.error);});"
                    + "return 'stored';");
            assertEquals("stored", inserted.getString("value"));
        } finally {
            instrumentation.runOnMainSync(first::finish);
        }

        MainActivity second = launch(instrumentation);
        try {
            JSONObject restored = run(instrumentation, second.getBridge().getWebView(),
                    "const tx=db.transaction('hybridTaskResolutions','readonly');"
                    + "const req=tx.objectStore('hybridTaskResolutions').get(" + JSONObject.quote(archiveId) + ");"
                    + "return await new Promise((resolve,reject)=>{req.onsuccess=()=>resolve(req.result);"
                    + "req.onerror=()=>reject(req.error);});");
            JSONObject record = restored.getJSONObject("value");
            assertEquals(entityId, record.getString("entityId"));
            assertEquals("CI offline edit", record.getJSONObject("localTask").getString("title"));
            assertEquals("CI remote edit", record.getJSONObject("serverPayload").getString("title"));
            assertEquals(1, record.getJSONArray("localOperations").length());
        } finally {
            run(instrumentation, second.getBridge().getWebView(),
                    "const tx=db.transaction('hybridTaskResolutions','readwrite');"
                    + "tx.objectStore('hybridTaskResolutions').delete(" + JSONObject.quote(archiveId) + ");"
                    + "await new Promise((resolve,reject)=>{tx.oncomplete=resolve;"
                    + "tx.onerror=()=>reject(tx.error);tx.onabort=()=>reject(tx.error);});"
                    + "return 'cleaned';");
            instrumentation.runOnMainSync(second::finish);
        }
    }
}
