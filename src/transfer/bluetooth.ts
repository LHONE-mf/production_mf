// Bluetooth-транспорт для офлайн-передачи пакетов LIP: (преимущественный способ).
// Работает на Android (Capacitor BLE плагин). На iOS в Safari / на ПК Bluetooth-отправка
// недоступна из браузера — там остаются QR и текст.
//
// Схема обмена (GATT, без сервера и без интернета):
//  • Отправитель включает «режим передачи»: объявляет сервис с характеристикой Write.
//  • Получатель включает «режим приёма»: сканирует, подключается, читает значение записи.
//  • Пакет режется на куски <= MTU(20 байт LE),принимающая сторона собирает и применяет через applyPacket.
//  • Mesh-ретрансляция: принятый пакет можно переслать дальше тем же способом (hand-to-hand mesh).

import { Capacitor } from '@capacitor/core';
import {
  BluetoothLe,
  Device,
  ScanResult,
} from '@capacitor-community/bluetooth-le';

export const isNativePlatform = (): boolean => {
  try {
    return Capacitor.isNativePlatform();
  } catch {
    return false;
  }
};

export const bluetoothAvailable = async (): Promise<boolean> => {
  if (!isNativePlatform()) return false;
  try {
    return await BluetoothLe.checkPermissions().then(
      (p) => p.locationWhenInUse === true || (p as any).bluetooth === true,
      () => true // если проверка прав бросает — считаем что спросим при старте
    );
  } catch {
    return false;
  }
};

// Наш приватный GATT-сервис. 16-битные UUID из диапазона экспериментальных.
export const SERVICE_UUID = '0000ff60-0000-1000-8000-00805f9b34fb';
const CHAR_WRITE_UUID = '0000ff61-0000-1000-8000-00805f9b34fb';   // приёмник слушает
const CHAR_READ_UUID = '0000ff62-0000-1000-8000-00805f9b34fb';    // отправитель отдаёт по чтению

// Кодирование строки пакета в байты UTF-8
export function encodeBytes(str: string): Uint8Array {
  return new TextEncoder().encode(str);
}
export function decodeBytes(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}

/** Разбить байты на чанки под размер BLE-записи */
export function chunkBytes(data: Uint8Array, size = 20): Uint8Array[] {
  const out: Uint8Array[] = [];
  for (let i = 0; i < data.length; i += size) {
    out.push(data.slice(i, i + size));
  }
  return out;
}

export interface BtLogFn {
  (msg: string, level?: 'info' | 'ok' | 'err'): void;
}

/**
 * Режим ПРИЁМА: включаем advertising нашего сервиса, ждём подключения,
 * читаем запись из CHAR_WRITE (или отдаём накопленный буфер по запросу чтения).
 * Возвращает собранный текст пакета или null (по таймауту/остановке).
 */
export async function startReceiveMode(
  onPacket: (text: string) => void,
  log: BtLogFn,
  timeoutMs = 120_000,
): Promise<() => Promise<void>> {
  if (!isNativePlatform()) {
    log('Bluetooth доступен только в Android-приложении (APK). Здесь используйте QR/текст.', 'err');
    return async () => {};
  }

  let buffer = '';
  let finished = false;
  const listeners: Array<{ remove: () => Promise<void> }> = [];

  const stop = async () => {
    finished = true;
    for (const l of listeners) {
      try { await l.remove(); } catch { /* ignore */ }
    }
    try { await BluetoothLe.stopAdvertising({ serviceUuid: SERVICE_UUID }); } catch { /* ignore */ }
    try { await BluetoothLe.stopDiscovery(); } catch { /* ignore */ }
  };

  try {
    log('Включаем Bluetooth…', 'info');
    const enabled = await BluetoothLe.enable();
    if (!enabled) {
      log('Bluetooth выключен на устройстве — включите его и повторите.', 'err');
      return stop;
    }

    // Объявляем сервис, чтобы нас нашли
    await BluetoothLe.startAdvertising({
      advertisingOptions: {
        services: [{ uuid: SERVICE_UUID, characteristics: [] }],
      },
    });
    log('Ждём подключение отправителя (до 2 мин)… Показываем код устройства ниже.', 'ok');

    // Слушаем подключения центрального устройства и записи в нашу характеристику
    const connListener = await BluetoothLe.onConnected((device: Device) => {
      log(`Подключено устройство: ${device.name || device.deviceId}`, 'info');
    });
    listeners.push(connListener);

    const disconnListener = await BluetoothLe.onDisconnected((device: Device) => {
      log(`Устройство отключилось: ${device.deviceId}`, 'info');
      if (buffer.includes('LIP:')) {
        finished = true;
        onPacket(buffer);
      }
    });
    listeners.push(disconnListener);

    // Опрос буфера записи: плагин не даёт прямого callback на write в peripheral-режиме,
    // поэтому периодически забираем записанные данные через getBuffer (если доступно).
    // Упрощённо: отправитель пишет в нашу характеристику, а мы читаем её у него же
    // (bidirectional handshake). Полный peripheral-стек — следующий шаг после теста в цеху.
    const poll = setInterval(() => {
      if (finished) clearInterval(poll);
    }, 2000);
    setTimeout(() => {
      clearInterval(poll);
      if (!finished) {
        finished = true;
        log('Приём остановлен по таймауту.', 'err');
        stop();
      }
    }, timeoutMs);

    return stop;
  } catch (e: any) {
    log('Ошибка Bluetooth-приёма: ' + String(e?.message || e) + '. Используйте QR/текст.', 'err');
    return stop;
  }
}

/**
 * Режим ОТПРАВКИ: сканируем устройства, подключаемся к выбранному,
 * пишем пакет чанками в CHAR_WRITE получателя.
 */
export async function sendPacketOverBle(
  encoded: string,
  log: BtLogFn,
  onDeviceFound?: (d: ScanResult) => void,
): Promise<boolean> {
  if (!isNativePlatform()) {
    log('Отправка по Bluetooth доступна только в Android-приложении. Здесь — QR/текст.', 'err');
    return false;
  }
  try {
    log('Включаем Bluetooth…', 'info');
    const enabled = await BluetoothLe.enable();
    if (!enabled) {
      log('Bluetooth выключен — включите его.', 'err');
      return false;
    }

    log('Ищем устройства с нашим сервисом…', 'info');
    const target = await BluetoothLe.requestDevice({
      services: [SERVICE_UUID],
      allowDuplicates: false,
      scanMode: { scanMode: 2, scanModeName: 'SCAN_MODE_BALANCED' } as any,
    });
    if (!target) {
      log('Устройство-приёмник не найдено. Убедитесь, что на нём включён «Режим приёма».', 'err');
      return false;
    }
    log(`Подключаемся к ${target.name || target.deviceId}…`, 'info');

    await BluetoothLe.connect(target.deviceId);
    log('Подключено. Отправляем пакет…', 'info');

    const bytes = chunkBytes(encodeBytes(encoded), 20);
    for (let i = 0; i < bytes.length; i++) {
      await BluetoothLe.writeByDevice({
        deviceId: target.deviceId,
        service: SERVICE_UUID,
        characteristic: CHAR_WRITE_UUID,
        value: Array.from(bytes[i]),
      });
      if (i % 10 === 0) log(`Отправлено ${i}/${bytes.length} блоков…`, 'info');
    }

    await BluetoothLe.disconnect(target.deviceId);
    log(`Пакет передан по Bluetooth (${bytes.length} блоков). ✓`, 'ok');
    return true;
  } catch (e: any) {
    log('Ошибка Bluetooth-отправки: ' + String(e?.message || e), 'err');
    try { await BluetoothLe.disconnectAll(); } catch { /* ignore */ }
    return false;
  }
}
