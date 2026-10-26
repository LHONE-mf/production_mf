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
import BleBridge from './BleBridge';
import { decodePacket } from './packet';

/** Нативный плагин доступен только в Android-APK */
const nativeBleAvailable = (): boolean => {
  try {
    return Capacitor.isNativePlatform() && Capacitor.getPlatform() === 'android';
  } catch {
    return false;
  }
};

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

// ────────────────────────────────────────────────────────────────────────────
// Протокол обмена (handshake по данным, без GATT-сервера на приёмнике):
//
//   • Приёмник (peripheral): включает advertising с именем "LIP-RX" и сканирует
//     эфир в поисках broadcast-пакета отправителя (manufacturer data с префиксом
//     "LIPW"). Когда видит запрос — начинает слушать notifications характеристики
//     TX всех устройств, рекламирующих наш сервис.
//   • Отправитель (central): кладёт заголовок пакета ("LIPW" + длина + CRC) в
//     manufacturer data своего advertising, затем сканирует, подключается к
//     приёмнику и пишет чанки пакета в характеристику RX. После записи делает
//     small delay, чтобы приёмник успевал собрать поток.
//   • Приёмник читает чанки через notify подписку, собирает строку, проверяет
//     CRC/полноту JSON → onPacket(). Затем ретранслирует (mesh) тот же пакет
//     дальше тем же способом.
//
// Почему так: бесплатная библиотека @capacitor-community/bluetooth-le не даёт
// создавать GATT-сервер на Android-приёмнике. Поэтому роли меняются местами:
//   ПРИЁМНИК выступает центральным устройством (central): сканирует эфир и
//   подписывается на notifications;
//   ОТПРАВИТЕЛЬ выступает периферийным устройством (peripheral): рекламирует
//   наш сервис и рассылает чанки пакета через notifications характеристики TX
//   всем подключившимся. Это позволяет одному отправителить раздать пакет
//   сразу нескольким приёмникам (основа mesh-ретрансляции).
// Discovery: отправитель кладёт заголовок (длина + CRC) в serviceData своего
// advertising; приёмник видит его при сканировании и подключается.
// ────────────────────────────────────────────────────────────────────────────

export const CHAR_TX_UUID = '0000ff62-0000-1000-8000-00805f9b34fb'; // notifications (поток данных)
export const ADV_NAME_TX = 'LIP-TX'; // имя отправителя в advertising
export const ADV_NAME_RX = 'LIP-RX'; // имя приёмника (для отображения в UI)
const CHUNK_SIZE_DEFAULT = 20;
const DELAY_MS = 80; // пауза между нотификациями, чтобы приёмник не терял блоки

/** Простейшая контрольная сумма для детекции обрыва/порчи потока */
function simpleChecksum(bytes: Uint8Array): number {
  let s = 0;
  for (let i = 0; i < bytes.length; i++) s = (s * 31 + bytes[i]) >>> 0;
  return s >>> 0;
}

/** Заголовок пакета: "LIPW" + длина (uint32 LE) + CRC (uint8) → в serviceData advertising */
export function encodeAdvHeader(totalLen: number, checksum: number): DataView {
  const buf = new Uint8Array(9);
  buf[0] = 0x4c; buf[1] = 0x49; buf[2] = 0x50; buf[3] = 0x57; // "LIPW"
  buf[4] = totalLen & 0xff;
  buf[5] = (totalLen >> 8) & 0xff;
  buf[6] = (totalLen >> 16) & 0xff;
  buf[7] = (totalLen >> 24) & 0xff;
  buf[8] = checksum & 0xff;
  return new DataView(buf.buffer);
}

/** Публичная обёртка контрольной суммы для модулей-отправителей (нативный плагин) */
export function packetChecksum(encoded: string): number {
  return simpleChecksum(encodeBytes(encoded)) & 0xff;
}

/** Разбор заголовка из serviceData/advertising: возвращает {len, checksum} или null */
function parseAdvHeader(dv: DataView | undefined | null): { len: number; checksum: number } | null {
  if (!dv || dv.byteLength < 9) return null;
  const b = new Uint8Array(dv.buffer, dv.byteOffset, dv.byteLength);
  if (b[0] !== 0x4c || b[1] !== 0x49 || b[2] !== 0x50 || b[3] !== 0x57) return null;
  const len = (b[4] | (b[5] << 8) | (b[6] << 16) | (b[7] << 24)) >>> 0;
  const checksum = b[8];
  return { len, checksum };
}

/** Извлекаем заголовок LIPW из результатов сканирования (serviceData / raw advertisement) */
function extractHeader(result: ScanResult): { len: number; checksum: number } | null {
  // 1) serviceData по нашему UUID
  const sd = result.serviceData?.[SERVICE_UUID] ?? result.serviceData?.[SERVICE_UUID.toUpperCase()];
  const fromSd = parseAdvHeader(sd);
  if (fromSd) return fromSd;
  // 2) manufacturer data (на случай, если реализация плагина кладёт туда)
  const mfdKeys = Object.keys(result.manufacturerData ?? {});
  for (const k of mfdKeys) {
    const h = parseAdvHeader(result.manufacturerData![k]);
    if (h) return h;
  }
  // 3) сырой advertising payload (Android only) — ищем сигнатуру "LIPW"
  const raw = (result as any).rawAdvertisement as DataView | undefined;
  if (raw && raw.byteLength >= 9) {
    const b = new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength);
    for (let i = 0; i + 9 <= b.length; i++) {
      if (b[i] === 0x4c && b[i + 1] === 0x49 && b[i + 2] === 0x50 && b[i + 3] === 0x57) {
        const len = (b[i + 4] | (b[i + 5] << 8) | (b[i + 6] << 16) | (b[i + 7] << 24)) >>> 0;
        if (len > 0 && len < 1_000_000) return { len, checksum: b[i + 8] };
      }
    }
  }
  return null;
}

/**
 * Режим ПРИЁМА (мы — центральное устройство): сканируем эфир в поисках
 * отправителя с заголовком LIPW в advertising, подключаемся к нему,
 * подписываемся на notifications характеристики TX и собираем чанки пакета.
 * Когда собрано ожидаемое количество байт и CRC сходится — отдаём пакет
 * через onPacket. Возвращает функцию остановки.
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

  // ── Основной путь: нативный плагин BleBridge (scan + GATT read) ──
  if (nativeBleAvailable()) {
    try {
      let handle: { remove: () => void } | null = null;
      let timer: ReturnType<typeof setTimeout> | null = null;
      let stopped = false;

      const cleanup = async () => {
        if (stopped) return;
        stopped = true;
        if (timer) clearTimeout(timer);
        try { if (handle) await handle.remove(); } catch { /* ignore */ }
        try { await BleBridge.stopReceive(); } catch { /* ignore */ }
      };

      handle = await BleBridge.addListener('packet', (ev) => {
        if (stopped) return;
        const idx = ev.packet.indexOf('LIP:');
        if (idx < 0) return;
        const payload = ev.packet.slice(idx);
        // Валидация через decodePacket: строка "LIP:<base64>" НЕ является JSON,
        // поэтому JSON.parse здесь всегда падал и молча отбрасывал пакеты.
        if (!decodePacket(payload)) return;
        log(`Пакет получен по BLE (${ev.len} байт, RSSI ${ev.rssi}) ✓`, 'ok');
        onPacket(payload);
      });

      await BleBridge.startReceive();
      log('Режим приёма активен (нативный BLE). Ждём передачи…', 'ok');

      timer = setTimeout(() => {
        if (!stopped) {
          log('Приём остановлен по таймауту (нет активности).', 'err');
          cleanup();
        }
      }, timeoutMs);

      return cleanup;
    } catch (e: any) {
      log('Нативный BLE недоступен (' + String(e?.message || e) + '), пробую запасной путь…', 'info');
    }
  }

  // ── Запасной путь: библиотека bluetooth-le (central + notifications) ──
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const seen = new Map<string, { chunks: number[]; expectedLen: number; checksum: number }>();

  const cleanup = async () => {
    stopped = true;
    if (timer) clearTimeout(timer);
    try { await BleClient.stopLEScan(); } catch { /* ignore */ }
    for (const deviceId of Array.from(seen.keys())) {
      try { await BleClient.stopNotifications(deviceId, SERVICE_UUID, CHAR_TX_UUID); } catch { /* ignore */ }
      try { await BleClient.disconnect(deviceId); } catch { /* ignore */ }
    }
  };

  const finalizePacket = (deviceId: string) => {
    const st = seen.get(deviceId);
    if (!st || !st.chunks.length) return;
    const bytes = new Uint8Array(st.chunks);
    const text = decodeBytes(bytes);
    const idx = text.indexOf('LIP:');
    if (idx < 0) return;
    const payload = text.slice(idx);
    try {
      // Полный пакет проверяем декодированием (JSON внутри base64, не сама строка)
      if (!decodePacket(payload)) return;
    } catch {
      return;
    }
    const cs = simpleChecksum(bytes) & 0xff;
    if (cs !== st.checksum) {
      log(`Контрольная сумма не совпала (${cs} ≠ ${st.checksum}). Пакет повреждён — ждём повторной передачи.`, 'err');
      return;
    }
    if (stopped) return;
    log(`Пакет получен (${bytes.length} байт) ✓`, 'ok');
    onPacket(payload);
    seen.delete(deviceId);
  };

  try {
    log('Включаем Bluetooth…', 'info');
    await ensureInitialized(log);

    log('Режим приёма активен. Ищем устройство-отправитель (до 3 мин)…', 'ok');

    await BleClient.requestLEScan(
      { services: [SERVICE_UUID], allowDuplicates: true },
      async (result: ScanResult) => {
        if (stopped) return;
        const dev = result.device;
        const deviceId = dev?.deviceId;
        if (!deviceId) return;

        // Уже обрабатываем это устройство?
        if (seen.has(deviceId)) {
          // соединение могло разорваться — пробуем переподписаться при следующем advertising
          return;
        }

        const hdr = extractHeader(result);
        if (!hdr) return; // это не наш отправитель

        seen.set(deviceId, { chunks: [], expectedLen: hdr.len, checksum: hdr.checksum });
        log(`Найден отправитель «${dev.name || result.localName || deviceId}» (пакет ~${hdr.len} байт). Подключаемся…`, 'info');

        try {
          await BleClient.connect(deviceId, (id) => {
            // при разрыве — пробуем финализировать собранное и убираем из списка,
            // чтобы следующий advertising позволил переподключиться
            finalizePacket(id);
            seen.delete(id);
          });
          await BleClient.startNotifications(
            deviceId,
            SERVICE_UUID,
            CHAR_TX_UUID,
            (value: DataView) => {
              const st = seen.get(deviceId);
              if (!st) return;
              st.chunks.push(...dataViewToNumbers(value));
              if (st.chunks.length >= st.expectedLen) {
                finalizePacket(deviceId);
              }
            },
          );
          log('Подписка на поток установлена. Ждём данные…', 'info');
        } catch (e: any) {
          log('Не удалось подключиться к отправителю: ' + String(e?.message || e), 'err');
          seen.delete(deviceId);
        }
      },
    );

    timer = setTimeout(() => {
      if (!stopped) {
        log('Приём остановлен по таймауту (нет активности).', 'err');
        cleanup();
      }
    }, timeoutMs);

    return cleanup;
  } catch (e: any) {
    log('Ошибка Bluetooth-приёма: ' + String(e?.message || e) + '. Используйте QR/текст.', 'err');
    await cleanup();
    return async () => {};
  }
}

/**
 * Режим ОТПРАВКИ (мы — периферийное устройство): рекламируем сервис LIP с
 * заголовком пакета в serviceData, ждём подключений от приёмников и рассылаем
 * чанки пакета через notifications характеристики TX. Пакет уходит сразу всем,
 * кто подключился (широковещательная рассылка — основа mesh).
 *
 * ВАЖНОЕ ОГРАНИЧЕНИЕ: бесплатная библиотека @capacitor-community/bluetooth-le
 * умеет только ЦЕНТРАЛЬНУЮ роль (сканировать/подключаться/писать). Полноценный
 * peripheral-режим (advertising + notify) в ней отсутствует, поэтому ниже
 * реализована отправка через запись в GATT-сервис приёмника (write path), если
 * приёмник запустит серверную часть (следующий модуль — нативный плагин), либо
 * через fallback: системный диалог выбора устройства + write в RX-характеристику.
 */
export async function sendPacketOverBle(
  encoded: string,
  log: BtLogFn,
): Promise<boolean> {
  if (!isNativePlatform()) {
    log('Отправка по Bluetooth доступна только в Android-приложении. Здесь — QR/текст.', 'err');
    return false;
  }

  // ── Основной путь: нативный плагин — широковещательная раздача пакета ──
  if (nativeBleAvailable()) {
    try {
      const bytes = encodeBytes(encoded);
      log(`Раздаю пакет по BLE (${bytes.length} байт). Приёмники должны быть в режиме приёма…`, 'info');
      const res = await BleBridge.startAdvertise({ packet: encoded });
      let clients = 0;
      const c1 = await BleBridge.addListener('txClientConnected', () => {
        clients++;
        log(`Приёмник подключился (${clients}). Отдаю данные…`, 'ok');
      });
      // Ждём 8 секунд — за это время все запустившие приём устройства успеют
      // просканировать, подключиться и прочитать характеристику.
      await new Promise((r) => setTimeout(r, 8000));
      await c1.remove();
      await BleBridge.stopAdvertise();
      if (clients > 0) {
        log(`Пакет роздан ${clients} приёмнику(ам) по Bluetooth ✓`, 'ok');
      } else {
        log('Ни один приёмник не подключился. Проверьте, что на них включён «Режим приёма».', 'err');
        return false;
      }
      void res;
      return true;
    } catch (e: any) {
      log('Нативная раздача недоступна (' + String(e?.message || e) + '), пробую ручное подключение…', 'info');
    }
  }

  // ── Запасной путь: системный диалог + запись в GATT приёмника ──
  try {
    log('Включаем Bluetooth…', 'info');
    await ensureInitialized(log);

    const bytes = encodeBytes(encoded);
    const parts = chunkBytes(bytes, CHUNK_SIZE_DEFAULT);
    log(`Пакет готов: ${bytes.length} байт (${parts.length} блоков). Ищем приёмник…`, 'info');

    // Приёмник должен быть в режиме приёма и показывать имя LIP-RX/LIP-TX в списке.
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
    try { await BleClient.discoverServices(target.deviceId); } catch { /* ignore */ }

    log(`Отправляем ${parts.length} блоков…`, 'info');
    for (let i = 0; i < parts.length; i++) {
      const dv = numbersToDataView(Array.from(parts[i]));
      try {
        await BleClient.writeWithoutResponse(target.deviceId, SERVICE_UUID, CHAR_WRITE_UUID, dv);
      } catch {
        // если без ответа не поддерживается — обычная запись
        await BleClient.write(target.deviceId, SERVICE_UUID, CHAR_WRITE_UUID, dv);
      }
      if (i % 10 === 0 && i > 0) log(`Отправлено ${i}/${parts.length} блоков…`, 'info');
      await new Promise((r) => setTimeout(r, DELAY_MS));
    }

    await BleClient.disconnect(target.deviceId);
    log(`Пакет передан по Bluetooth (${parts.length} блоков). ✓`, 'ok');
    return true;
  } catch (e: any) {
    log('Ошибка Bluetooth-отправки: ' + String(e?.message || e), 'err');
    return false;
  }
}
