// Реальный QR-сканер через камеру на html5-qrcode.
// Используется в IngestPanel («Синхронизация») и CommunicationModule («Связь»).
// Поддерживает одиночные пакеты LIP:... и кадры многокадровой передачи LIPM:...
// (сборку кадров делает decodePacketFromQr — сюда приходит текст каждого распознанного QR).

import React, { useEffect, useRef } from 'react';
import { Html5Qrcode } from 'html5-qrcode';

interface Props {
  /** Вызывается для КАЖДОГО распознанного текста QR (в т.ч. каждого кадра LIPM) */
  onResult: (text: string) => void;
  /** Закрыть сканер */
  onClose: () => void;
  /** true — не останавливаться после первого результата (нужно для многокадровых пакетов) */
  continuous?: boolean;
}

export function QrScanner({ onResult, onClose, continuous = true }: Props) {
  const scannerRef = useRef<Html5Qrcode | null>(null);
  const regionId = useRef(`qr-scan-${Math.random().toString(36).slice(2, 8)}`);
  const lastTextRef = useRef<{ text: string; at: number }>({ text: '', at: 0 });
  const [error, setError] = React.useState<string | null>(null);
  const [count, setCount] = React.useState(0);
  const stoppedRef = useRef(false);

  useEffect(() => {
    const el = document.getElementById(regionId.current);
    if (!el) return;
    const scanner = new Html5Qrcode(regionId.current);
    scannerRef.current = scanner;
    let disposed = false;

    scanner
      .start(
        { facingMode: 'environment' },
        { fps: 10, qrbox: { width: 240, height: 240 } },
        (decodedText) => {
          // дедупликация: одна и та же картинка распознаётся много раз за секунду
          const now = Date.now();
          if (lastTextRef.current.text === decodedText && now - lastTextRef.current.at < 1500) return;
          lastTextRef.current = { text: decodedText, at: now };
          onResult(decodedText);
          setCount((c) => c + 1);
          if (!continuous) void stopScan();
        },
        () => {
          /* кадры без QR — игнорируем молча */
        }
      )
      .catch((e: unknown) => {
        if (!disposed) {
          setError(
            e instanceof Error && /not allowed|Permission/i.test(e.message)
              ? 'Нет доступа к камере. Разрешите съёмку в настройках браузера/приложения.'
              : 'Не удалось запустить камеру. На ПК можно использовать вставку текста пакета.'
          );
        }
      });

    const stopScan = async () => {
      try {
        if (scannerRef.current?.isScanning) await scannerRef.current.stop();
      } catch {
        /* уже остановлен */
      }
      scannerRef.current?.clear();
      scannerRef.current = null;
    };

    return () => {
      disposed = true;
      void stopScan();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="space-y-2">
      <div id={regionId.current} className="w-full max-w-sm mx-auto rounded-lg overflow-hidden bg-black" />
      {error ? (
        <p className="text-red-400 text-xs">{error}</p>
      ) : (
        <p className="text-slate-400 text-xs">
          Наводите камеру на QR. Большой пакет передаётся несколькими кадрами — снимайте их по очереди
          (отправитель переключает кадры кнопками «Дальше ▶»). Распознано кадров: {count}.
        </p>
      )}
      <button
        onClick={() => {
          if (!stoppedRef.current) {
            stoppedRef.current = true;
            const s = scannerRef.current;
            if (s) {
              (async () => {
                try { if (s.isScanning) await s.stop(); } catch { /* noop */ }
                s.clear();
                scannerRef.current = null;
              })();
            }
          }
          onClose();
        }}
        className="px-4 py-2 bg-slate-700 hover:bg-slate-600 rounded text-sm text-white font-medium"
      >
        ✖ Закрыть сканер
      </button>
    </div>
  );
}
