// Хук управления Bluetooth-обменом пакетами LIP: (Android APK).
// Даёт: статус, лог, запуск приёма, остановку, отправку.

import { useCallback, useRef, useState } from 'react';
import { SyncPacket } from '../core/types';
import { encodePacket } from './packet';
import { applyPacket, ApplyResult } from './apply';
import { startReceiveMode, sendPacketOverBle, isNativePlatform } from './bluetooth';

export type BtStatus = 'idle' | 'receiving' | 'sending' | 'error';

export interface BtLogLine {
  time: string;
  msg: string;
  level: 'info' | 'ok' | 'err';
}

export function useBluetooth(onApplied?: (res: ApplyResult) => void) {
  const [status, setStatus] = useState<BtStatus>('idle');
  const [logLines, setLogLines] = useState<BtLogLine[]>([]);
  const stopRef = useRef<null | (() => Promise<void>)>(null);
  const available = isNativePlatform();

  const log = useCallback((msg: string, level: 'info' | 'ok' | 'err' = 'info') => {
    const time = new Date().toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    setLogLines((prev) => [...prev.slice(-50), { time, msg, level }]);
  }, []);

  const stop = useCallback(async () => {
    if (stopRef.current) {
      await stopRef.current();
      stopRef.current = null;
    }
    setStatus('idle');
  }, []);

  /** Включить режим приёма: другое устройство может отправить нам пакет по BLE */
  const startReceiving = useCallback(() => {
    if (!available) {
      log('Bluetooth доступен только в Android-приложении (APK). На ПК/iOS используйте QR или текст.', 'err');
      return;
    }
    setStatus('receiving');
    log('Запуск режима приёма…', 'info');
    startReceiveMode(
      async (text) => {
        // буфер содержит полный текст пакета — декодируем и применяем
        try {
          const idx = text.indexOf('LIP:');
          const clean = idx >= 0 ? text.slice(idx) : text;
          // применяем через общий механизм (decode внутри applyPacket вызывается на уровне IngestPanel,
          // поэтому здесь сначала достанем пакет)
          const { decodePacket } = await import('./packet');
          const p = decodePacket(clean);
          if (!p) {
            log('Принятые данные не распознаны как пакет LIP:', 'err');
            return;
          }
          const res = await applyPacket(p);
          log(res.ok ? `Пакет принят и применён: ${res.message}` : `Приём с ошибкой: ${res.message}`, res.ok ? 'ok' : 'err');
          onApplied?.(res);
        } catch (e: any) {
          log('Ошибка применения принятого пакета: ' + String(e?.message || e), 'err');
        } finally {
          setStatus('idle');
        }
      },
      log,
    ).then((stopFn) => {
      stopRef.current = stopFn;
    });
  }, [available, log, onApplied]);

  /** Отправить пакет по Bluetooth (выбор устройства — системным диалогом Android) */
  const send = useCallback(
    async (packet: SyncPacket) => {
      if (!available) {
        log('Отправка по Bluetooth доступна только в Android-приложении. Здесь выберите QR или текст.', 'err');
        return false;
      }
      setStatus('sending');
      log('Подготовка к отправке…', 'info');
      let encoded = '';
      try {
        encoded = await encodePacket(packet);
      } catch (e: any) {
        log('Не удалось закодировать пакет: ' + String(e?.message || e), 'err');
        setStatus('error');
        return false;
      }
      const ok = await sendPacketOverBle(encoded, log);
      setStatus(ok ? 'idle' : 'error');
      return ok;
    },
    [available, log],
  );

  return { status, logLines, available, startReceiving, stop, send, clearLog: () => setLogLines([]) };
}
