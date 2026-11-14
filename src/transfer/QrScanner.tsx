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
  instructions?: string;
  fallbackMessage?: string;
}

export function QrScanner({ onResult, onClose, continuous = true, instructions, fallbackMessage }: Props) {
  const scannerRef = useRef<Html5Qrcode | null>(null);
  const regionId = useRef(`qr-scan-${Math.random().toString(36).slice(2, 8)}`);
  const lastTextRef = useRef<{ text: string; at: number }>({ text: '', at: 0 });
  const [error, setError] = React.useState<string | null>(null);
  const [count, setCount] = React.useState(0);

  useEffect(() => {
    const el = document.getElementById(regionId.current);
    if (!el) return;
    const scanner = new Html5Qrcode(regionId.current);
    scannerRef.current = scanner;
    let disposed = false;
    let stopping: Promise<void> | undefined;
    const stopScan = () => {
      if (!stopping) stopping = (async () => {
        // A pending start can obtain the camera after unmount. Stop that exact
        // scanner once startup settles instead of losing its reference early.
        try { await starting; } catch { /* Startup failure has no stream to stop. */ }
        try { if (scanner.isScanning) await scanner.stop(); } catch { /* Already stopped. */ }
        scanner.clear();
        if (scannerRef.current === scanner) scannerRef.current = null;
      })();
      return stopping;
    };

    const starting = scanner.start(
        { facingMode: 'environment' },
        { fps: 10, qrbox: { width: 240, height: 240 } },
        (decodedText) => {
          if (disposed) return;
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
      );
    starting.catch((e: unknown) => {
        if (!disposed) {
          setError(
            e instanceof Error && /not allowed|Permission/i.test(e.message)
              ? 'Нет доступа к камере. Разрешите съёмку в настройках браузера/приложения.'
              : fallbackMessage ?? 'Не удалось запустить камеру. На ПК можно использовать вставку текста пакета.'
          );
        }
      });

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
          {instructions ?? <>Наводите камеру на QR. Большой пакет передаётся несколькими кадрами — снимайте их по очереди (отправитель переключает кадры кнопками «Дальше ▶»). Распознано кадров: {count}.</>}
        </p>
      )}
      <button
        onClick={onClose}
        className="px-4 py-2 bg-slate-700 hover:bg-slate-600 rounded text-sm text-white font-medium"
      >
        ✖ Закрыть сканер
      </button>
    </div>
  );
}
