package ru.liion.production;

import android.annotation.SuppressLint;
import android.bluetooth.BluetoothAdapter;
import android.bluetooth.BluetoothDevice;
import android.bluetooth.BluetoothGatt;
import android.bluetooth.BluetoothGattCallback;
import android.bluetooth.BluetoothGattCharacteristic;
import android.bluetooth.BluetoothGattServer;
import android.bluetooth.BluetoothGattServerCallback;
import android.bluetooth.BluetoothGattService;
import android.bluetooth.BluetoothManager;
import android.bluetooth.BluetoothProfile;
import android.bluetooth.le.AdvertiseCallback;
import android.bluetooth.le.AdvertiseData;
import android.bluetooth.le.AdvertiseSettings;
import android.bluetooth.le.BluetoothLeAdvertiser;
import android.bluetooth.le.BluetoothLeScanner;
import android.bluetooth.le.ScanCallback;
import android.bluetooth.le.ScanFilter;
import android.bluetooth.le.ScanResult;
import android.bluetooth.le.ScanSettings;
import android.content.Context;
import android.os.Handler;
import android.os.Looper;
import android.os.ParcelUuid;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;

/**
 * BleBridgePlugin — нативный BLE-мост для офлайн-передачи пакетов LIP.
 *
 * СХЕМА (без сервера и интернета):
 *  • ПЕРЕДАТЧИК: startAdvertise({packet}) — кладёт заголовок "LIPW"+len+crc в
 *    serviceData advertising, открывает GATT-сервер (сервис FF60, char FF61).
 *    Каждый подключившийся приёмник читает характеристику FF61 — сервер отдаёт
 *    весь пакет (Android сам фрагментирует read-ответ по MTU).
 *  • ПРИЁМНИК: startReceive() — сканирует advertising с нашим UUID, читает
 *    заголовок из serviceData, подключается, делает read(FF61), проверяет CRC,
 *    отдаёт пакет в JS через событие "packet" и отключается.
 *  • MESH: дедупликация по len+crc; принявший пакет может ретранслировать его
 *    стартом того же advertise (в JS: retransmit = startAdvertise тем же пакетом).
 */
@CapacitorPlugin(name = "BleBridge")
public class BleBridgePlugin extends Plugin {

    private static final ParcelUuid SERVICE_UUID =
            ParcelUuid.fromString("0000FF60-0000-1000-8000-00805F9B34FB");
    private static final ParcelUuid SHORT_UUID =
            ParcelUuid.fromString("0000FF60-0000-1000-8000-00805F9B34FB");
    private static final ParcelUuid CHAR_DATA_UUID =
            ParcelUuid.fromString("0000FF61-0000-1000-8000-00805F9B34FB");

    private BluetoothAdapter adapter;
    private final Handler ui = new Handler(Looper.getMainLooper());

    // ── передатчик ──
    private AdvertiseCallback advCallback;
    private volatile boolean advertising = false;
    private volatile byte[] currentPayload = new byte[0];
    private BluetoothGattServer gattServer;

    // ── приёмник ──
    private ScanCallback scanCb;
    private volatile boolean scanning = false;
    private final Set<String> seenPackets = new HashSet<>();
    private final Map<String, Boolean> connectingDevices = new HashMap<>();

    @Override
    public void load() {
        BluetoothManager mgr = (BluetoothManager) getContext().getSystemService(Context.BLUETOOTH_SERVICE);
        if (mgr != null) adapter = mgr.getAdapter();
    }

    private boolean btReady(PluginCall call) {
        if (adapter == null || !adapter.isEnabled()) {
            call.reject("BLUETOOTH_OFF");
            return false;
        }
        return true;
    }

    // ════════════════ ПЕРЕДАТЧИК ════════════════

    @SuppressLint("MissingPermission")
    @PluginMethod
    public void startAdvertise(final PluginCall call) {
        if (!btReady(call)) return;
        final String packet = call.getString("packet", "");
        if (packet.isEmpty()) { call.reject("EMPTY_PACKET"); return; }

        byte[] payload = packet.getBytes(StandardCharsets.UTF_8);
        int len = payload.length;
        int crc = checksum(packet);

        byte[] header = new byte[9];
        header[0] = 'L'; header[1] = 'I'; header[2] = 'P'; header[3] = 'W';
        header[4] = (byte) (len & 0xff);
        header[5] = (byte) ((len >> 8) & 0xff);
        header[6] = (byte) ((len >> 16) & 0xff);
        header[7] = (byte) ((len >> 24) & 0xff);
        header[8] = (byte) (crc & 0xff);

        stopAdvertisingInternal();
        currentPayload = payload;

        BluetoothLeAdvertiser adv = adapter.getBluetoothLeAdvertiser();
        if (adv == null) { call.reject("NO_ADVERTISER"); return; }

        openGattServer();

        AdvertiseSettings settings = new AdvertiseSettings.Builder()
                .setAdvertiseMode(AdvertiseSettings.ADVERTISE_MODE_LOW_LATENCY)
                .setTxPowerLevel(AdvertiseSettings.ADVERTISE_TX_POWER_HIGH)
                .setConnectable(true)
                .setTimeout(0)
                .build();

        // Реклама разбита на два блока, чтобы не превысить 31 байт payload:
        //  • ADV-пакет: только 16-битный UUID сервиса (5 байт) — влезает гарантированно;
        //  • SCAN RESPONSE: serviceData с заголовком пакета (полные 128-бит UUID + 9 байт).
        // Приёмник сканирует с setScanResponse(true), поэтому заголовок приходит.
        AdvertiseData data = new AdvertiseData.Builder()
                .addServiceUuid(SHORT_UUID)
                .setIncludeDeviceName(false)
                .setIncludeTxPowerLevel(false)
                .build();

        AdvertiseData scanResponse = new AdvertiseData.Builder()
                .addServiceData(SERVICE_UUID, header)
                .setIncludeDeviceName(false)
                .build();

        advCallback = new AdvertiseCallback() {
            @Override
            public void onStartSuccess(AdvertiseSettings s) {
                advertising = true;
                JSObject ret = new JSObject();
                ret.put("ok", true);
                ret.put("len", len);
                ret.put("crc", crc);
                call.resolve(ret);
            }

            @Override
            public void onStartFailure(int errorCode) {
                closeGattServer();
                call.reject("ADV_FAIL_" + errorCode);
            }
        };

        try {
            adv.startAdvertising(settings, data, scanResponse, advCallback);
        } catch (SecurityException e) {
            call.reject("PERMISSION_DENIED");
        }
    }

    @PluginMethod
    public void stopAdvertise(final PluginCall call) {
        stopAdvertisingInternal();
        closeGattServer();
        JSObject ret = new JSObject();
        ret.put("ok", true);
        call.resolve(ret);
    }

    @SuppressLint("MissingPermission")
    private void stopAdvertisingInternal() {
        if (adapter != null && advCallback != null) {
            try {
                BluetoothLeAdvertiser a = adapter.getBluetoothLeAdvertiser();
                if (a != null) a.stopAdvertising(advCallback);
            } catch (SecurityException ignored) {}
            advCallback = null;
        }
        advertising = false;
    }

    @SuppressLint("MissingPermission")
    private void openGattServer() {
        if (gattServer != null) return;
        BluetoothManager mgr = (BluetoothManager) getContext().getSystemService(Context.BLUETOOTH_SERVICE);
        if (mgr == null) return;
        gattServer = mgr.openGattServer(getContext(), new BluetoothGattServerCallback() {
            @Override
            public void onConnectionStateChange(BluetoothDevice device, int status, int newState) {
                JSObject ev = new JSObject();
                ev.put("value", device.getAddress());
                notifyListeners(newState == BluetoothProfile.STATE_CONNECTED
                        ? "txClientConnected" : "txClientDisconnected", ev);
            }

            @Override
            public synchronized void onCharacteristicReadRequest(BluetoothDevice device, int requestId,
                                                                  int offset, BluetoothGattCharacteristic charac) {
                if (gattServer == null) return;
                byte[] payload = currentPayload; // volatile snapshot
                if (CHAR_DATA_UUID.getUuid().equals(charac.getUuid())) {
                    int chunkLen = Math.min(182, Math.max(0, payload.length - offset));
                    byte[] slice = new byte[chunkLen];
                    System.arraycopy(payload, offset, slice, 0, chunkLen);
                    try {
                        gattServer.sendResponse(device, requestId, BluetoothGatt.GATT_SUCCESS, offset, slice);
                    } catch (SecurityException ignored) {}
                } else {
                    try {
                        gattServer.sendResponse(device, requestId, 0x83, offset, null);
                    } catch (SecurityException ignored) {}
                }
            }
        });

        BluetoothGattService service = new BluetoothGattService(
                SERVICE_UUID.getUuid(), BluetoothGattService.SERVICE_TYPE_PRIMARY);
        BluetoothGattCharacteristic ch = new BluetoothGattCharacteristic(
                CHAR_DATA_UUID.getUuid(),
                BluetoothGattCharacteristic.PROPERTY_READ,
                BluetoothGattCharacteristic.PERMISSION_READ);
        service.addCharacteristic(ch);
        try {
            gattServer.addService(service);
        } catch (SecurityException ignored) {}
    }

    private void closeGattServer() {
        if (gattServer != null) {
            try { gattServer.clearServices(); gattServer.close(); } catch (Exception ignored) {}
            gattServer = null;
        }
        currentPayload = new byte[0];
    }

    // ════════════════ ПРИЁМНИК ════════════════

    @SuppressLint("MissingPermission")
    @PluginMethod
    public void startReceive(final PluginCall call) {
        if (!btReady(call)) return;
        stopScanningInternal();
        synchronized (seenPackets) { seenPackets.clear(); }

        BluetoothLeScanner scanner = adapter.getBluetoothLeScanner();
        if (scanner == null) { call.reject("NO_SCANNER"); return; }

        List<ScanFilter> filters = new ArrayList<>();
        // Фильтр по 16-битному UUID (совпадает с полным FF60 в ADV-пакете).
        filters.add(new ScanFilter.Builder().setServiceUuid(SHORT_UUID).build());

        ScanSettings settings = new ScanSettings.Builder()
                .setScanMode(ScanSettings.SCAN_MODE_LOW_LATENCY)
                // Обязательно: заголовок пакета лежит в SCAN RESPONSE, без этого флага
                // он не придёт и приёмник не увидит, что подключаться.
                .setCallbackType(ScanSettings.CALLBACK_TYPE_ALL_MATCHES)
                .setMatchMode(ScanSettings.MATCH_MODE_AGGRESSIVE)
                .build();

        scanCb = new ScanCallback() {
            @Override
            public void onScanResult(int callbackType, ScanResult result) {
                handleScanResult(result);
            }

            @Override
            public void onBatchScanResults(List<ScanResult> results) {
                for (ScanResult r : results) handleScanResult(r);
            }
        };

        try {
            scanner.startScan(filters, settings, scanCb);
            scanning = true;
            JSObject ret = new JSObject();
            ret.put("ok", true);
            call.resolve(ret);
        } catch (SecurityException e) {
            call.reject("PERMISSION_DENIED");
        }
    }

    @SuppressLint("MissingPermission")
    private void handleScanResult(final ScanResult result) {
        if (result == null || result.getScanRecord() == null) return;
        byte[] sd = result.getScanRecord().getServiceData(SERVICE_UUID);
        if (sd == null || sd.length < 9) return;
        if (sd[0] != 'L' || sd[1] != 'I' || sd[2] != 'P' || sd[3] != 'W') return;

        final int len = (sd[4] & 0xff) | ((sd[5] & 0xff) << 8) | ((sd[6] & 0xff) << 16) | ((sd[7] & 0xff) << 24);
        final int crc = sd[8] & 0xff;
        if (len <= 0 || len > 200000) return;

        final String key = len + ":" + crc;
        synchronized (seenPackets) {
            if (seenPackets.contains(key)) return;
        }

        final BluetoothDevice dev = result.getDevice();
        if (dev == null) return;
        synchronized (connectingDevices) {
            if (Boolean.TRUE.equals(connectingDevices.get(dev.getAddress()))) return;
            connectingDevices.put(dev.getAddress(), Boolean.TRUE);
        }

        readFromPeripheral(dev, len, crc, new ReadDone() {
            @Override public void run(String packet, boolean ok) {
                synchronized (connectingDevices) { connectingDevices.remove(dev.getAddress()); }
                if (ok && packet != null) {
                    synchronized (seenPackets) { seenPackets.add(key); }
                    JSObject ev = new JSObject();
                    ev.put("packet", packet);
                    ev.put("len", len);
                    ev.put("rssi", result.getRssi());
                    notifyListeners("packet", ev);
                }
            }
        });
    }

    private interface ReadDone { void run(String packet, boolean ok); }

    @SuppressLint("MissingPermission")
    private void readFromPeripheral(final BluetoothDevice dev, final int expectedLen, final int expectedCrc,
                                    final ReadDone done) {
        final BluetoothGatt[] gattHolder = new BluetoothGatt[1];
        final boolean[] finished = {false};

        BluetoothGattCallback cb = new BluetoothGattCallback() {
            @Override
            public void onConnectionStateChange(BluetoothGatt gatt, int status, int newState) {
                if (newState == BluetoothProfile.STATE_CONNECTED) {
                    try { gatt.discoverServices(); }
                    catch (SecurityException e) { finish(false, null); }
                } else {
                    finish(false, null);
                    try { gatt.close(); } catch (Exception ignored) {}
                }
            }

            @Override
            public void onServicesDiscovered(BluetoothGatt gatt, int st) {
                if (st != BluetoothGatt.GATT_SUCCESS) { finish(false, null); return; }
                BluetoothGattService svc = gatt.getService(SERVICE_UUID.getUuid());
                if (svc == null) { finish(false, null); return; }
                BluetoothGattCharacteristic ch = svc.getCharacteristic(CHAR_DATA_UUID.getUuid());
                if (ch == null) { finish(false, null); return; }
                try {
                    if (!gatt.readCharacteristic(ch)) finish(false, null);
                } catch (SecurityException e) {
                    finish(false, null);
                }
            }

            @Override
            public void onCharacteristicRead(BluetoothGatt gatt, BluetoothGattCharacteristic ch, int st) {
                byte[] value = ch.getValue();
                if (st == BluetoothGatt.GATT_SUCCESS && value != null && value.length == expectedLen) {
                    String text = new String(value, StandardCharsets.UTF_8);
                    if (text.startsWith("LIP:") && checksum(text) == expectedCrc) {
                        finish(true, text);
                    } else {
                        finish(false, null);
                    }
                } else {
                    finish(false, null);
                }
            }

            private void finish(boolean ok, String text) {
                synchronized (finished) {
                    if (finished[0]) return;
                    finished[0] = true;
                }
                BluetoothGatt g = gattHolder[0];
                if (g != null) {
                    try { g.disconnect(); } catch (Exception ignored) {}
                    try { g.close(); } catch (Exception ignored) {}
                }
                done.run(text, ok);
            }
        };

        try {
            gattHolder[0] = dev.connectGatt(getContext(), false, cb, BluetoothDevice.TRANSPORT_LE);
        } catch (SecurityException e) {
            done.run(null, false);
            return;
        }

        // Таймаут 20 секунд на чтение одного пакета
        ui.postDelayed(new Runnable() {
            @Override public void run() {
                synchronized (finished) {
                    if (finished[0]) return;
                    finished[0] = true;
                }
                BluetoothGatt g = gattHolder[0];
                if (g != null) {
                    try { g.disconnect(); g.close(); } catch (Exception ignored) {}
                }
                done.run(null, false);
            }
        }, 20000);
    }

    @SuppressLint("MissingPermission")
    @PluginMethod
    public void stopReceive(final PluginCall call) {
        stopScanningInternal();
        JSObject ret = new JSObject();
        ret.put("ok", true);
        call.resolve(ret);
    }

    @SuppressLint("MissingPermission")
    private void stopScanningInternal() {
        if (adapter != null && scanCb != null) {
            try {
                BluetoothLeScanner s = adapter.getBluetoothLeScanner();
                if (s != null) s.stopScan(scanCb);
            } catch (SecurityException ignored) {}
            scanCb = null;
        }
        scanning = false;
    }

    // ════════════════ УТИЛИТЫ ════════════════

    /** Точная копия simpleChecksum из src/transfer/bluetooth.ts (uint32, затем & 0xff) */
    private static int checksum(String str) {
        byte[] bytes = str.getBytes(StandardCharsets.UTF_8);
        long s = 0;
        for (byte b : bytes) {
            s = (s * 31 + (b & 0xff)) & 0xffffffffL;
        }
        return (int) (s & 0xff);
    }

    @PluginMethod
    public void getStatus(final PluginCall call) {
        JSObject ret = new JSObject();
        ret.put("btOn", adapter != null && adapter.isEnabled());
        ret.put("advertising", advertising);
        ret.put("scanning", scanning);
        call.resolve(ret);
    }

    @Override
    protected void handleOnDestroy() {
        stopScanningInternal();
        stopAdvertisingInternal();
        closeGattServer();
        super.handleOnDestroy();
    }
}
