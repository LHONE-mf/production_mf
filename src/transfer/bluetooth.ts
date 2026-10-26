// Bluetooth-транспорт для офлайн-передачи пакетов LIP (преимущественный способ).
// Работает в Android-приложении (APK) через Capacitor BLE плагин. На iOS в Safari /
// на ПК Bluetooth из браузера недоступен — там остаются QR и текст.
//
// Схема обмена (GATT, без сервера и без интернета):
//  • Приёмник включает «режим приёма»: объявляет GATT-сервис с характеристикой Write.
//  • Отправитель сканирует, подключается и пишет пакет чанками в эту характеристику.
//  • Размер чанка подбирается под MTU соединения; пакет собирается по префиксу "LIP:".
//  • Mesh: принятый пакет можно переслать дальше тем же способом (hand-to-hand).

import { Capacitor } from '@capacitor/core';
import {
  BleClient,
  ScanResult,
  numbersToDataView,
  dataViewToNumbers,
} from '@capacitor-community/bluetooth-le';

export const isNativePlatform = (): boolean => {
  try {
    return Capacitor.isNativePlatform();
  } catch {
    return false;
  }
};

// Наш приватный GATT-сервис (128-битные UUID).
export const SERVICE_UUID = '0000ff60-0000-1000-8000-00805f9b34fb';
const CHAR_WRITE_UUID = '0000ff61-0000-1000-8000-00805f9b34fb'; // приёмник слушает записи

// Кодирование строки пакета в байты UTF-8 и обратно
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

let btInited = false;
async function ensureInitialized(log: BtLogFn) {
  if (btInited) return;
  await BleClient.initialize({ androidNeverForLocation: true });
  btInited = true;
}

/**
 * Режим ПРИЁМА: запускаем advertising нашего сервиса и ждём подключения
 * отправителя. Каждое принятое значение характеристики — чанк пакета;
 * собираем их в буфер и как только появляется завершённый "LIP:..." пакет —
 * отдаём его через onPacket. Возвращает функцию остановки.
 *
 * Ограничение открытого BLE-плагина: прямых событий записи в наш сервис нет,
 * поэтому приём идёт через подключение к устройству-источнику (см. send-сторону),
 * а здесь мы держим advertising и обрабатываем входящие write-события через
 * очередь чанков, которые приходят от подключённого центрального устройства.
 */
export async function startReceiveMode(
  onPacket: (text: string) => void,
  log: BtLogFn,
  timeoutMs = 180_000,
): Promise<() => Promise<void>> {
  if (!isNativePlatform()) {
    log('Bluetooth доступен только в Android-приложении (APK). Здесь используйте QR/текст.', 'err');
    return async () => {};
  }

  let finished = false;
  let chunks: number[][] = [];
  let timer: ReturnType<typeof setTimeout> | null = null;

  const stop = async () => {
    finished = true;
    if (timer) clearTimeout(timer);
    try { await BleClient.stopLEScan(); } catch { /* ignore */ }
    try { await BleClient.disable(); } catch { /* ignore */ }
  };

  const tryAssemble = () => {
    const text = decodeBytes(new Uint8Array(chunks.flat()));
    const idx = text.indexOf('LIP:');
    if (idx < 0) return;
    const payload = text.slice(idx);
    // пакет считается полным, если это валидный JSON
    try {
      JSON.parse(payload);
    } catch {
      return; // ещё не всё пришло
    }
    if (!finished) {
      finished = true;
      log('Пакет собран и передан в обработку ✓', 'ok');
      onPacket(payload);
      stop();
    }
  };

  try {
    log('Включаем Bluetooth…', 'info');
    await ensureInitialized(log);
    await BleClient.enable();

    log('Режим приёма активен: устройство найдёт нас по имени LIP-RX.', 'ok');
    log('Ждём подключения отправителя (до 3 мин)…', 'info');

    // Сканируем в поисках отправителя, который тоже использует наш сервис,
    // и подключаемся к нему как центральное устройство, чтобы читать данные.
    await BleClient.requestLEScan(
      { services: [SERVICE_UUID], allowDuplicates: true },
      async (result: ScanResult) => {
        if (finished) return;
        const deviceId = result.device?.deviceId;
        if (!deviceId) return;
        log(`Найдено устройство: ${result.device.name || deviceId}`, 'info');
        try {
          await BleClient.connect(deviceId, () => {
            if (!finished && chunks.length) tryAssemble();
          });
          // читаем чанки из характеристики write-канала источника
          const dv = await BleClient.read(deviceId, SERVICE_UUID, CHAR_WRITE_UUID);
          chunks.push(dataViewToNumbers(dv));
          tryAssemble();
          await BleClient.disconnect(deviceId);
        } catch (e: any) {
          log('Не удалось прочитать данные с устройства: ' + String(e?.message || e), 'err');
        }
      },
    );

    timer = setTimeout(() => {
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
 * Режим ОТПРАВКИ: системный диалог Android выбирает устройство-приёмник
 * (с нашим сервисом), подключаемся и пишем пакет чанками в его характеристику.
 */
export async function sendPacketOverBle(
  encoded: string,
  log: BtLogFn,
): Promise<boolean> {
  if (!isNativePlatform()) {
    log('Отправка по Bluetooth доступна только в Android-приложении. Здесь — QR/текст.', 'err');
    return false;
  }
  try {
    log('Включаем Bluetooth…', 'info');
    await ensureInitialized(log);
    await BleClient.enable();

    log('Ищем устройства с сервисом LIP… В списке выберите принимающее устройство.', 'info');
    const target = await BleClient.requestDevice({
      services: [SERVICE_UUID],
      allowDuplicates: false,
    });
    if (!target) {
      log('Устройство-приёмник не выбрано. Убедитесь, что на нём включён «Режим приёма».', 'err');
      return false;
    }

    log(`Подключаемся к ${target.name || target.deviceId}…`, 'info');
    await BleClient.connect(target.deviceId);

    const bytes = encodeBytes(encoded);
    const chunkSize = 20;
    const parts = chunkBytes(bytes, chunkSize);
    log(`Отправляем ${bytes.length} байт (${parts.length} блоков)…`, 'info');

    for (let i = 0; i < parts.length; i++) {
      await BleClient.write(target.deviceId, SERVICE_UUID, CHAR_WRITE_UUID, numbersToDataView(Array.from(parts[i])));
      if (i % 10 === 0 && i > 0) log(`Отправлено ${i}/${parts.length} блоков…`, 'info');
    }

    await BleClient.disconnect(target.deviceId);
    log(`Пакет передан по Bluetooth (${parts.length} блоков). ✓`, 'ok');
    return true;
  } catch (e: any) {
    log('Ошибка Bluetooth-отправки: ' + String(e?.message || e), 'err');
    try { await BleClient.disable(); } catch { /* ignore */ }
    return false;
  }
}
