package ru.liion.production;

import android.os.Bundle;
import android.graphics.Color;
import android.view.Window;
import android.view.ViewGroup;
import androidx.core.view.WindowCompat;
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
        // Android 15+ enforces edge-to-edge for target SDK 35+. Inset the
        // native content *container*, rather than the WebView drawing surface.
        // On older Android versions keep the existing platform-managed layout.
        Window window = getWindow();
        if (android.os.Build.VERSION.SDK_INT >= 35) {
            WindowCompat.setDecorFitsSystemWindows(window, false);
            window.setStatusBarColor(Color.TRANSPARENT);
            window.setNavigationBarColor(Color.TRANSPARENT);

            // The transparent system bars show this dark background, while
            // the WebView itself is laid out safely between the system bars.
            final ViewGroup contentRoot = findViewById(android.R.id.content);
            contentRoot.setBackgroundColor(Color.rgb(30, 41, 59));
            ViewCompat.setOnApplyWindowInsetsListener(contentRoot, (view, insets) -> {
                Insets safe = insets.getInsets(WindowInsetsCompat.Type.systemBars()
                        | WindowInsetsCompat.Type.displayCutout());
                view.setPadding(safe.left, safe.top, safe.right, safe.bottom);
                return insets; // Preserve IME insets for WebView keyboard behavior.
            });
            ViewCompat.requestApplyInsets(contentRoot);
        } else {
            window.setStatusBarColor(Color.rgb(30, 41, 59));
            window.setNavigationBarColor(Color.rgb(15, 23, 42));
        }
        WindowCompat.getInsetsController(window, window.getDecorView())
                .setAppearanceLightStatusBars(false);
        WindowCompat.getInsetsController(window, window.getDecorView())
                .setAppearanceLightNavigationBars(false);
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
