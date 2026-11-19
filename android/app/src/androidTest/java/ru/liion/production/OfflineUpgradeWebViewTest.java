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
import org.junit.Assume;
import org.junit.Test;
import org.junit.runner.RunWith;

import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;

/** Disposable emulator only: verifies real APK replacement retains IndexedDB state.
 * Run twice with upgradePhase=prepare/verify, with adb install -r between them.
 * No wipe, uninstall, live credentials, or production records are used. */
@RunWith(AndroidJUnit4.class)
public class OfflineUpgradeWebViewTest {
    private static final String RESULT = "window.__productionMfUpgradeProbe";
    private static final String ENTITY_ID = "99999999-9999-4999-8999-999999999999";
    private static final String ARCHIVE_ID = "ci-android-upgrade-archive";
    private static final String ACTOR = "ci-android-upgrade-actor";
    private static final String DRAFT_KEY = "[\"ci-android-upgrade-actor\",\"slurry\"]";

    private static String eval(Instrumentation instrumentation, WebView view, String script) throws Exception {
        CountDownLatch done = new CountDownLatch(1);
        AtomicReference<String> result = new AtomicReference<>();
        instrumentation.runOnMainSync(() -> view.evaluateJavascript(script, value -> {
            result.set(value);
            done.countDown();
        }));
        assertTrue("WebView JavaScript timed out", done.await(30, TimeUnit.SECONDS));
        return result.get();
    }

    private static JSONObject run(Instrumentation instrumentation, WebView view, String action) throws Exception {
        String script = RESULT + " = null; (async function() {"
                + "const request = indexedDB.open('LiIonProductionDB');"
                + "const db = await new Promise((resolve,reject) => {"
                + "request.onsuccess=()=>resolve(request.result);"
                + "request.onerror=()=>reject(request.error);});"
                + "try {"
                + "for(const store of ['hybridTaskResolutions','hybridTaskRevisions','localFormDrafts']) {"
                + "if(!db.objectStoreNames.contains(store)) throw Error('Missing '+store);}"
                + action
                + "} finally { db.close(); }"
                + "})().then(value => { " + RESULT + " = JSON.stringify({value}); })"
                + ".catch(error => { " + RESULT + " = JSON.stringify({error:String(error)}); });";
        eval(instrumentation, view, script);
        for (int attempt = 0; attempt < 120; attempt++) {
            Object result = new JSONTokener(eval(instrumentation, view, RESULT)).nextValue();
            if (result instanceof String) {
                JSONObject parsed = new JSONObject((String) result);
                assertTrue("Upgrade probe failed: " + parsed, !parsed.has("error"));
                return parsed;
            }
            Thread.sleep(250);
        }
        throw new AssertionError("IndexedDB upgrade probe timed out");
    }

    @Test
    public void preservesOfflineStateAcrossInstalledApkUpgrade() throws Exception {
        String phase = InstrumentationRegistry.getArguments().getString("upgradePhase", "");
        // Never seed test rows during ordinary Android instrumentation runs.
        Assume.assumeTrue("Run only in isolated installed-upgrade CI",
                "prepare".equals(phase) || "verify".equals(phase));
        Instrumentation instrumentation = InstrumentationRegistry.getInstrumentation();
        Intent intent = new Intent(instrumentation.getTargetContext(), MainActivity.class);
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TASK);
        MainActivity activity = (MainActivity) instrumentation.startActivitySync(intent);
        assertNotNull(activity.getBridge());
        WebView view = activity.getBridge().getWebView();
        try {
            boolean ready = false;
            for (int attempt = 0; attempt < 120; attempt++) {
                if ("true".equals(eval(instrumentation, view,
                        "Boolean(window.Capacitor && window.indexedDB && document.readyState==='complete' && location.origin==='https://localhost')"))) {
                    ready = true;
                    break;
                }
                Thread.sleep(250);
            }
            assertTrue("Production MF Capacitor WebView was not ready", ready);
            // Allow the production Dexie schema to finish opening before the raw IndexedDB probe.
            Thread.sleep(3000);
            assertEquals("Capacitor page changed during startup", "true", eval(instrumentation, view,
                    "Boolean(window.Capacitor && document.readyState==='complete' && location.origin==='https://localhost')"));
            if ("prepare".equals(phase)) {
                JSONObject saved = run(instrumentation, view,
                        "const tx=db.transaction(['hybridTaskResolutions','hybridTaskRevisions','localFormDrafts'],'readwrite');"
                        + "tx.objectStore('hybridTaskResolutions').add({id:" + JSONObject.quote(ARCHIVE_ID)
                        + ",entityId:" + JSONObject.quote(ENTITY_ID)
                        + ",archivedAt:Date.now(),decision:'use_server',"
                        + "localTask:{title:'TEST-APK-UPGRADE offline edit'},"
                        + "localOperations:[{operationId:'ci-upgrade-operation'}],"
                        + "serverRevision:7,serverPayload:{title:'TEST-APK-UPGRADE remote edit'}});"
                        + "tx.objectStore('hybridTaskRevisions').add({entityId:" + JSONObject.quote(ENTITY_ID)
                        + ",revision:7});"
                        + "tx.objectStore('localFormDrafts').add({key:" + JSONObject.quote(DRAFT_KEY)
                        + ",actorId:" + JSONObject.quote(ACTOR)
                        + ",scope:'slurry',version:1,revision:1,updatedAt:Date.now(),"
                        + "payload:{note:'TEST-APK-UPGRADE',mass:'12.5'}});"
                        + "return await new Promise((resolve,reject)=>{"
                        + "tx.oncomplete=()=>resolve('saved');"
                        + "tx.onerror=()=>reject(tx.error);tx.onabort=()=>reject(tx.error);});");
                assertEquals("saved", saved.getString("value"));
            } else {
                JSONObject rows = run(instrumentation, view,
                        "const tx=db.transaction(['hybridTaskResolutions','hybridTaskRevisions','localFormDrafts'],'readonly');"
                        + "const get=(store,key)=>new Promise((resolve,reject)=>{"
                        + "const request=tx.objectStore(store).get(key);"
                        + "request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error);});"
                        + "const [archive,revision,draft]=await Promise.all(["
                        + "get('hybridTaskResolutions'," + JSONObject.quote(ARCHIVE_ID) + "),"
                        + "get('hybridTaskRevisions'," + JSONObject.quote(ENTITY_ID) + "),"
                        + "get('localFormDrafts'," + JSONObject.quote(DRAFT_KEY) + ")]);"
                        + "return {archive,revision,draft};").getJSONObject("value");
                assertEquals(ENTITY_ID, rows.getJSONObject("archive").getString("entityId"));
                assertEquals("TEST-APK-UPGRADE offline edit",
                        rows.getJSONObject("archive").getJSONObject("localTask").getString("title"));
                assertEquals(1, rows.getJSONObject("archive").getJSONArray("localOperations").length());
                assertEquals(7, rows.getJSONObject("revision").getInt("revision"));
                assertEquals("slurry", rows.getJSONObject("draft").getString("scope"));
                assertEquals("12.5", rows.getJSONObject("draft").getJSONObject("payload").getString("mass"));
                // Clean up only these disposable CI rows after proving they survived replacement.
                assertEquals("cleaned", run(instrumentation, view,
                        "const tx=db.transaction(['hybridTaskResolutions','hybridTaskRevisions','localFormDrafts'],'readwrite');"
                        + "tx.objectStore('hybridTaskResolutions').delete(" + JSONObject.quote(ARCHIVE_ID) + ");"
                        + "tx.objectStore('hybridTaskRevisions').delete(" + JSONObject.quote(ENTITY_ID) + ");"
                        + "tx.objectStore('localFormDrafts').delete(" + JSONObject.quote(DRAFT_KEY) + ");"
                        + "return await new Promise((resolve,reject)=>{tx.oncomplete=()=>resolve('cleaned');"
                        + "tx.onerror=()=>reject(tx.error);tx.onabort=()=>reject(tx.error);});")
                        .getString("value"));
            }
        } finally {
            instrumentation.runOnMainSync(activity::finish);
        }
    }
}
