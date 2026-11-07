package ru.liion.production;

import android.os.Bundle;
import android.graphics.Color;
import android.view.Window;
import android.view.WindowManager;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        // Регистрация нативного BLE-плагина (advertiser + GATT server + scanner)
        registerPlugin(BleBridgePlugin.class);
        super.onCreate(savedInstanceState);
        // Keep the Android status/navigation bars visible and match the dark app chrome.
        Window window = getWindow();
        window.setStatusBarColor(Color.rgb(30, 41, 59));
        window.setNavigationBarColor(Color.rgb(15, 23, 42));
    }
}
