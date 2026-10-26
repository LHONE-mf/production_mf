// Панель офлайн-передачи: показать QR/текст исходящего пакета и принять входящий (вставка текста).
// Bluetooth — преимущественный способ приёма (Android APK): «Режим приёма» слушает эфир и сам
// применяет входящие пакеты LIP:. На ПК/iOS доступны QR и текст.

import React, { useEffect, useRef, useState } from 'react';
import { QRCodeSVG } from 'qrcode.react';
import { useAuthStore } from '../core/store/authStore';
import { SyncPacket } from '../core/types';
import { encodePacket, decodePacket } from './packet';
import { applyPacket, ApplyResult } from './apply';
import { useBluetooth } from './useBluetooth';

interface Props {
  /** Функция, собирающая исходящий пакет (например, задание) */
  buildOutgoing?: () => SyncPacket | null;
}

export function IngestPanel({ buildOutgoing }: Props) {
  const currentUser = useAuthStore((s) => s.currentUser);
  const [incomingText, setIncomingText] = useState('');
  const [result, setResult] = useState<ApplyResult | null>(null);
  const [outgoing, setOutgoing] = useState<string | null>(null);
  const bt = useBluetooth((res) => setResult(res));

  // Останавливаем BLE-приём при размонтировании панели
  const stopRef = useRef(bt.stop);
  stopRef.current = bt.stop;
  useEffect(() => () => { stopRef.current(); }, []);

  const showOutgoing = async () => {
    const p = buildOutgoing?.();
    if (!p) return;
    setOutgoing(await encodePacket(p));
  };

  const acceptIncoming = async () => {
    const p = decodePacket(incomingText);
    if (!p) {
      setResult({ ok: false, message: 'Не найден пакет формата LIP:... в тексте' });
      return;
    }
    // Защита: forced-пакеты принимаем только если отправитель — master/chief
    const res = await applyPacket(p);
    setResult(res);
    setIncomingText('');
  };

  return (
    <div className="bg-slate-800 border border-slate-700 rounded-lg p-4 space-y-4">
      <h3 className="text-white font-semibold">📡 Офлайн-передача (Bluetooth / QR / текст)</h3>

      {/* Bluetooth-приём — преимущественный способ */}
      <div className="space-y-2 border border-blue-500/30 bg-blue-500/5 rounded-lg p-3">
        <p className="text-xs text-slate-300 font-medium">🔵 Bluetooth (преимущественный способ, Android APK)</p>
        <p className="text-[11px] text-slate-500">
          Включите режим приёма — устройство будет искать пакеты от других телефонов цеха.
          {!bt.available && <span className="text-amber-400 block mt-1">⚠ В веб-версии Bluetooth недоступен — используйте QR/текст ниже.</span>}
        </p>
        <div className="flex gap-2">
          {bt.status === 'receiving' ? (
            <button onClick={bt.stop} className="px-4 py-2 bg-red-600/80 hover:bg-red-500 rounded text-sm text-white font-medium">
              ⏹ Остановить приём
            </button>
          ) : (
            <button
              onClick={bt.startReceiving}
              disabled={!bt.available}
              className="px-4 py-2 bg-emerald-600 hover:bg-emerald-500 disabled:opacity-40 rounded text-sm text-white font-medium"
            >
              📥 Режим приёма
            </button>
          )}
        </div>
        {bt.logLines.length > 0 && (
          <div className="bg-slate-900 border border-slate-700 rounded p-2 max-h-32 overflow-y-auto space-y-1">
            {bt.logLines.map((l, i) => (
              <div key={i} className={`text-[11px] font-mono ${l.level === 'err' ? 'text-red-400' : l.level === 'ok' ? 'text-emerald-400' : 'text-slate-400'}`}>
                <span className="opacity-60">{l.time}</span> {l.msg}
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Исходящий пакет */}
      {buildOutgoing && (
        <div className="space-y-2">
          <button onClick={showOutgoing} className="px-4 py-2 bg-green-600 hover:bg-green-500 rounded text-sm text-white font-medium">
            Сформировать QR для передачи
          </button>
          {outgoing && (
            <div className="flex flex-col items-center gap-2 bg-white rounded-lg p-3 w-fit">
              <QRCodeSVG value={outgoing} size={180} />
              <textarea readOnly className="w-64 text-[10px] font-mono" rows={3} value={outgoing} />
              <button
                onClick={() => navigator.clipboard?.writeText(outgoing)}
                className="text-xs text-slate-600 underline"
              >
                Скопировать текст пакета
              </button>
            </div>
          )}
        </div>
      )}

      {/* Входящий пакет */}
      <div className="space-y-2">
        <textarea
          className="w-full bg-slate-900 border border-slate-700 rounded px-3 py-2 text-sm text-white placeholder-slate-500 font-mono"
          rows={3}
          placeholder="Вставьте скопированное сообщение или отсканируйте QR (камера — в разделе «Связь»)... Пакет начинается с LIP:"
          value={incomingText}
          onChange={(e) => setIncomingText(e.target.value)}
        />
        <button
          onClick={acceptIncoming}
          disabled={!incomingText.trim()}
          className="px-4 py-2 bg-blue-600 hover:bg-blue-500 disabled:opacity-50 rounded text-sm text-white font-medium"
        >
          Принять и применить
        </button>
        {result && (
          <p className={`text-sm ${result.ok ? 'text-green-400' : 'text-red-400'}`}>
            {result.ok ? '✔ ' : '✖ '}{result.message}
          </p>
        )}
      </div>
      <p className="text-xs text-slate-500">
        Отправитель: {currentUser?.fullName ?? '—'}. Пакеты master'а с флагом forced применяются безусловно.
      </p>
    </div>
  );
}
