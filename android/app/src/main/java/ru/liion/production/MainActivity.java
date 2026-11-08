package ru.liion.production;

import android.os.Bundle;
import android.graphics.Color;
import android.view.Window;
import androidx.core.view.ViewCompat;
import androidx.core.view.WindowInsetsCompat;
import androidx.core.graphics.Insets;
import android.os.SystemClock;
import android.widget.Toast;
import androidx.activity.OnBackPressedCallback;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    private long lastBackPressMs = 0L;
    private static final long EXIT_WINDOW_MS = 2000L;
    @Override
    public void onCreate(Bundle savedInstanceState) {
        // Регистрация нативного BLE-плагина (advertiser + GATT server + scanner)
        registerPlugin(BleBridgePlugin.class);
        registerPlugin(DeviceProofPlugin.class);
        super.onCreate(savedInstanceState);
        // Keep the Android status/navigation bars visible and match the dark app chrome.
        Window window = getWindow();
        window.setStatusBarColor(Color.rgb(30, 41, 59));
        window.setNavigationBarColor(Color.rgb(15, 23, 42));
        // Android 15+ draws behind system bars. Keep the WebView content
        // inside the actual status/navigation insets, including cutouts.
        final android.webkit.WebView webView = getBridge().getWebView();
        ViewCompat.setOnApplyWindowInsetsListener(webView, (view, insets) -> {
            Insets safe = insets.getInsets(WindowInsetsCompat.Type.systemBars()
                    | WindowInsetsCompat.Type.displayCutout());
            view.setPadding(safe.left, safe.top, safe.right, safe.bottom);
            return insets;
        });
        ViewCompat.requestApplyInsets(webView);
        // White system-bar icons remain readable on the app's dark chrome.
        window.getDecorView().setSystemUiVisibility(0);
        if (android.os.Build.VERSION.SDK_INT >= 29) {
            window.setStatusBarContrastEnforced(false);
            window.setNavigationBarContrastEnforced(false);
        }
        getOnBackPressedDispatcher().addCallback(this, new OnBackPressedCallback(true) {
            @Override
            public void handleOnBackPressed() {
                long now = SystemClock.elapsedRealtime();
                if (now - lastBackPressMs <= EXIT_WINDOW_MS) {
                    finish();
                } else {
                    lastBackPressMs = now;
                    Toast.makeText(MainActivity.this, "Нажмите Назад ещё раз для выхода", Toast.LENGTH_SHORT).show();
                }
            }
        });
    }
}
