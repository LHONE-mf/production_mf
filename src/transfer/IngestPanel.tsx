// Панель офлайн-передачи: показать QR/текст исходящего пакета и принять входящий (вставка текста).
// Bluetooth-транспорт подключается сюда же (mesh) — см. transfer/bluetooth.ts (следующий модуль).

import React, { useState } from 'react';
import { QRCodeSVG } from 'qrcode.react';
import { useAuthStore } from '../core/store/authStore';
import { SyncPacket } from '../core/types';
import { encodePacket, decodePacket } from './packet';
import { applyPacket, ApplyResult } from './apply';

interface Props {
  /** Функция, собирающая исходящий пакет (например, задание) */
  buildOutgoing?: () => SyncPacket | null;
}

export function IngestPanel({ buildOutgoing }: Props) {
  const currentUser = useAuthStore((s) => s.currentUser);
  const [incomingText, setIncomingText] = useState('');
  const [result, setResult] = useState<ApplyResult | null>(null);
  const [outgoing, setOutgoing] = useState<string | null>(null);

  const showOutgoing = () => {
    const p = buildOutgoing?.();
    if (!p) return;
    setOutgoing(encodePacket(p));
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
      <h3 className="text-white font-semibold">📡 Офлайн-передача (QR / текст)</h3>

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
