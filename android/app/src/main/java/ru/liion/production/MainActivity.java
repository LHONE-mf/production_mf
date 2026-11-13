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
        // Android 15+ (and Android 16+) displays target-35 apps edge-to-edge.
        // Make this behavior consistent on older Android versions too, and
        // inset the native *container*, not the WebView's own drawing surface.
        // WebView padding alone does not reliably move HTML below the status bar.
        Window window = getWindow();
        WindowCompat.setDecorFitsSystemWindows(window, false);
        window.setStatusBarColor(Color.TRANSPARENT);
        window.setNavigationBarColor(Color.TRANSPARENT);
        if (android.os.Build.VERSION.SDK_INT >= 29) {
            window.setStatusBarContrastEnforced(false);
            window.setNavigationBarContrastEnforced(false);
        }
        WindowCompat.getInsetsController(window, window.getDecorView())
                .setAppearanceLightStatusBars(false);
        WindowCompat.getInsetsController(window, window.getDecorView())
                .setAppearanceLightNavigationBars(false);

        // The content view occupies the full window. Its padding creates
        // a safe, measurable layout area for all web screens and overlays.
        // Keep the padding updated on rotation, gesture-mode changes, etc.
        final ViewGroup contentRoot = findViewById(android.R.id.content);
        contentRoot.setBackgroundColor(Color.rgb(30, 41, 59));
        ViewCompat.setOnApplyWindowInsetsListener(contentRoot, (view, insets) -> {
            Insets safe = insets.getInsets(WindowInsetsCompat.Type.systemBars()
                    | WindowInsetsCompat.Type.displayCutout());
            view.setPadding(safe.left, safe.top, safe.right, safe.bottom);
            return insets;
        });
        ViewCompat.requestApplyInsets(contentRoot);
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
