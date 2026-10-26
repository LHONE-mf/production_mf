package ru.liion.production;

import android.os.Bundle;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        // Регистрация нативного BLE-плагина (advertiser + GATT server + scanner)
        registerPlugin(BleBridgePlugin.class);
        super.onCreate(savedInstanceState);
    }
}
