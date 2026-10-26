// Общий UI-помощник вывода пакета: выбор способа офлайн-передачи.
// Порядок: Bluetooth — преимущественный способ (Android APK), затем QR, затем текст.
// Никакого онлайна!

import React, { useEffect, useState } from 'react';
import { QRCodeSVG } from 'qrcode.react';
import { SyncPacket } from '../../core/types';
import { encodePacket } from '../../transfer/packet';
import { useBluetooth } from '../../transfer/useBluetooth';

interface Props {
  packet: SyncPacket;
  onClose: () => void;
}

type Tab = 'bluetooth' | 'qr' | 'text';

export function PacketOutModal({ packet, onClose }: Props) {
  const [encoded, setEncoded] = useState('');
  // encodePacket теперь async (подпись пакета WebCrypto) — считаем в useEffect.
  useEffect(() => {
    let alive = true;
    encodePacket(packet)
      .then((s) => { if (alive) setEncoded(s); })
      .catch((e) => console.error('PacketOutModal: не удалось закодировать пакет', e));
    return () => { alive = false; };
  }, [packet]);

  const bt = useBluetooth();
  const [tab, setTab] = useState<Tab>('bluetooth');
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(encoded);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* без клипборда — можно выделить текст вручную */
    }
  };

  const tabs: Array<{ id: Tab; label: string; hint: string }> = [
    { id: 'bluetooth', label: '🔵 Bluetooth', hint: 'преимущественный способ' },
    { id: 'qr', label: '▦ QR-код', hint: 'камера другого устройства' },
    { id: 'text', label: '✉ Текст', hint: 'скопировать и передать' },
  ];

  return (
    <div className="fixed inset-0 z-50 bg-black/70 flex items-center justify-center p-4" onClick={onClose}>
      <div
        className="bg-slate-800 border border-slate-600 rounded-xl p-4 max-w-md w-full space-y-3 max-h-[92vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between">
          <h3 className="text-white font-semibold">Передача данных офлайн</h3>
          <button onClick={onClose} className="text-slate-400 hover:text-white text-xl leading-none">×</button>
        </div>

        {/* Выбор способа передачи */}
        <div className="grid grid-cols-3 gap-2">
          {tabs.map((t) => (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              className={`rounded-lg px-2 py-2 text-xs font-medium border transition ${
                tab === t.id
                  ? 'bg-blue-600/30 border-blue-400 text-white'
                  : 'bg-slate-900/40 border-slate-700 text-slate-400 hover:border-slate-500'
              }`}
            >
              <div>{t.label}</div>
              <div className="text-[10px] opacity-70">{t.hint}</div>
            </button>
          ))}
        </div>

        {!encoded && (
          <p className="text-red-400 text-sm">Не удалось закодировать пакет для передачи.</p>
        )}

        {tab === 'bluetooth' && encoded && (
          <div className="space-y-3">
            <p className="text-xs text-slate-400">
              Работает в Android-приложении (APK). На принимающем устройстве откройте
              «Синхронизация → Bluetooth» и включите <b>режим приёма</b>, затем здесь нажмите
              <b> «Раздать пакет»</b> — устройство само раздаст пакет всем приёмникам рядом
              (широковещательно, без выбора устройства). В веб-версии Bluetooth недоступен.
              {!bt.available && (
                <span className="text-amber-400 block mt-1">
                  ⚠ В веб-версии Bluetooth недоступен — используйте QR или текст.
                </span>
              )}
            </p>

            {bt.status === 'receiving' || bt.status === 'sending' ? (
              <button
                onClick={bt.stop}
                className="w-full px-4 py-2 bg-red-600/80 hover:bg-red-500 rounded text-sm text-white font-medium"
              >
                Остановить
              </button>
            ) : (
              <div className="grid grid-cols-2 gap-2">
                <button
                  onClick={bt.startReceiving}
                  disabled={!bt.available}
                  className="px-4 py-2 bg-emerald-600 hover:bg-emerald-500 disabled:opacity-40 rounded text-sm text-white font-medium"
                >
                  📥 Режим приёма
                </button>
                <button
                  onClick={() => bt.send(packet)}
                  disabled={!bt.available || !encoded}
                  className="px-4 py-2 bg-blue-600 hover:bg-blue-500 disabled:opacity-40 rounded text-sm text-white font-medium"
                >
                  📤 Раздать пакет
                </button>
              </div>
            )}

            {bt.logLines.length > 0 && (
              <div className="bg-slate-900 border border-slate-700 rounded p-2 max-h-36 overflow-y-auto space-y-1">
                {bt.logLines.map((l, i) => (
                  <div
                    key={i}
                    className={`text-[11px] font-mono ${
                      l.level === 'err' ? 'text-red-400' : l.level === 'ok' ? 'text-emerald-400' : 'text-slate-400'
                    }`}
                  >
                    <span className="opacity-60">{l.time}</span> {l.msg}
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {tab === 'qr' && encoded && (
          <div className="space-y-3">
            <p className="text-xs text-slate-400">
              Покажите QR на принимающем устройстве («Принять пакет» в Синхронизации или вкладке «Связь»).
            </p>
            <div className="bg-white rounded-lg p-3 flex justify-center">
              <QRCodeSVG value={encoded} size={220} />
            </div>
          </div>
        )}

        {tab === 'text' && encoded && (
          <div className="space-y-2">
            <p className="text-xs text-slate-400">
              Скопируйте текст и передайте любым сообщением — приложение подхватит пакет LIP: само.
            </p>
            <textarea
              readOnly
              rows={4}
              className="w-full bg-slate-900 border border-slate-700 rounded px-2 py-1 text-[10px] font-mono text-slate-300"
              value={encoded}
            />
            <button
              onClick={copy}
              className="w-full px-4 py-2 bg-blue-600 hover:bg-blue-500 rounded text-sm text-white font-medium"
            >
              {copied ? 'Скопировано ✓' : 'Скопировать текст пакета'}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

// Небольшой помощник: только QR-картинка из закодированного текста пакета.
// Используется в чате (ChatModule), чтобы не дублировать модалку целиком.
export function PacketQrView({ text }: { text: string }) {
  return (
    <div className="bg-white rounded-lg p-3 flex justify-center">
      <QRCodeSVG value={text} size={220} />
    </div>
  );
}
