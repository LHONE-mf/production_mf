package ru.liion.production;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertTrue;

import android.content.Intent;
import android.view.ViewGroup;
import android.webkit.WebView;
import androidx.core.graphics.Insets;
import androidx.core.view.ViewCompat;
import androidx.core.view.WindowInsetsCompat;
import androidx.test.platform.app.InstrumentationRegistry;
import androidx.test.core.app.ApplicationProvider;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.core.app.ActivityScenario;
import org.junit.Test;
import org.junit.runner.RunWith;

@RunWith(AndroidJUnit4.class)
public class ProductionMfLaunchTest {
    @Test
    public void launchesMainActivityOnAndroidEmulator() {
        Intent intent = new Intent(ApplicationProvider.getApplicationContext(), MainActivity.class);
        try (ActivityScenario<MainActivity> scenario = ActivityScenario.launch(intent)) {
            scenario.onActivity(activity -> {
                assertNotNull(activity);
                assertEquals("ru.liion.production", activity.getPackageName());
            });
        }
    }
    @Test
    public void webContentDoesNotOverlapAndroidSystemBars() {
        Intent intent = new Intent(ApplicationProvider.getApplicationContext(), MainActivity.class);
        try (ActivityScenario<MainActivity> scenario = ActivityScenario.launch(intent)) {
            // Allow the decor and the first insets/layout dispatch to settle.
            InstrumentationRegistry.getInstrumentation().waitForIdleSync();
            scenario.onActivity(activity -> {
                ViewGroup contentRoot = activity.findViewById(android.R.id.content);
                WebView webView = activity.getBridge().getWebView();
                assertNotNull(contentRoot);
                assertNotNull(webView);

                WindowInsetsCompat windowInsets = ViewCompat.getRootWindowInsets(contentRoot);
                assertNotNull("Window insets must be available", windowInsets);
                Insets safe = windowInsets.getInsets(WindowInsetsCompat.Type.systemBars()
                        | WindowInsetsCompat.Type.displayCutout());

                // Insets belong to the container; do not put WebView HTML
                // underneath the Android clock, camera cutout, or nav gestures.
                assertEquals(safe.top, contentRoot.getPaddingTop());
                assertEquals(safe.bottom, contentRoot.getPaddingBottom());
                assertEquals(safe.left, contentRoot.getPaddingLeft());
                assertEquals(safe.right, contentRoot.getPaddingRight());
                assertTrue("Expected a status-bar inset on the emulator", safe.top > 0);
                assertTrue("WebView must be laid out", webView.getHeight() > 0);
                int[] position = new int[2];
                webView.getLocationOnScreen(position);
                assertTrue("WebView still overlaps Android status bar", position[1] >= safe.top);
            });
        }
    }

}
