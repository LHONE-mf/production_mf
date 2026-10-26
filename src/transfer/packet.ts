// Единый офлайн-формат пакета для Bluetooth / QR / текста.
// JSON → base64 (префикс "LIP:"). При автоподхвате из текста ищем подстроку LIP:...

import { SyncPacket } from '../core/types';

export const PACKET_PREFIX = 'LIP:';

/** Пакет → текст для QR / сообщения */
export function encodePacket(p: SyncPacket): string {
  const json = JSON.stringify({ ...p, payload: p.payload });
  // btoa не любит кириллицу — сначала в UTF-8 escape
  const utf8 = unescape(encodeURIComponent(json));
  return PACKET_PREFIX + btoa(utf8);
}

/** Текст (из QR/сообщения) → пакет; null если это не наш пакет */
export function decodePacket(text: string): SyncPacket | null {
  try {
    const idx = text.indexOf(PACKET_PREFIX);
    if (idx === -1) return null;
    let b64 = text.slice(idx + PACKET_PREFIX.length).trim().split(/\s+/)[0];
    // добить base64 padding
    while (b64.length % 4) b64 += '=';
    const json = decodeURIComponent(escape(atob(b64)));
    const obj = JSON.parse(json) as SyncPacket;
    if (obj.v !== 1 || !obj.type) return null;
    return obj;
  } catch {
    return null;
  }
}

/** Разбить большой текст пакета на QR-кадры по ~1200 символов */
export function toQrChunks(encoded: string, chunkSize = 1200): string[] {
  const chunks: string[] = [];
  for (let i = 0; i < encoded.length; i += chunkSize) {
    chunks.push(encoded.slice(i, i + chunkSize));
  }
  return chunks;
}
