// Общий UI-помощник комнаты замесов: вывод пакета (QR / текст) для офлайн-передачи.
// Никакого онлайна — только QR, текст, позже Bluetooth тем же форматом LIP:.

import React, { useState } from 'react';
import { QRCodeSVG } from 'qrcode.react';
import { SyncPacket } from '../../../core/types';
import { encodePacket } from '../../../transfer/packet';

interface Props {
  packet: SyncPacket;
  onClose: () => void;
}

export function PacketOutModal({ packet, onClose }: Props) {
  const [encoded] = useState(() => encodePacket(packet));
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

  return (
    <div className="fixed inset-0 z-50 bg-black/70 flex items-center justify-center p-4" onClick={onClose}>
      <div
        className="bg-slate-800 border border-slate-600 rounded-xl p-4 max-w-md w-full space-y-3"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between">
          <h3 className="text-white font-semibold">Передача данных офлайн</h3>
          <button onClick={onClose} className="text-slate-400 hover:text-white text-xl leading-none">×</button>
        </div>
        <p className="text-xs text-slate-400">
          Покажите QR на принимающем устройстве («Принять пакет» в Синхронизации) либо скопируйте
          текст и передайте сообщением — приложение подхватит пакет само.
        </p>
        <div className="bg-white rounded-lg p-3 flex justify-center">
          <QRCodeSVG value={encoded} size={220} />
        </div>
        <textarea readOnly rows={3} className="w-full bg-slate-900 border border-slate-700 rounded px-2 py-1 text-[10px] font-mono text-slate-300" value={encoded} />
        <button
          onClick={copy}
          className="w-full px-4 py-2 bg-blue-600 hover:bg-blue-500 rounded text-sm text-white font-medium"
        >
          {copied ? 'Скопировано ✓' : 'Скопировать текст пакета'}
        </button>
      </div>
    </div>
  );
}
