// Единый офлайн-формат пакета для Bluetooth / QR / текста.
// JSON → base64 (префикс "LIP:"). При автоподхвате из текста ищем подстроку LIP:...

import { SyncPacket, UserRole } from '../core/types';
import { signPacket } from '../core/security';

export const PACKET_PREFIX = 'LIP:';

/** Роль текущего пользователя из zustand-persist сессии (localStorage). */
export function currentSenderRole(): UserRole | undefined {
  try {
    const raw = localStorage.getItem('auth-storage');
    if (!raw) return undefined;
    const st = JSON.parse(raw)?.state?.session;
    return st?.user?.role ?? st?.role;
  } catch {
    return undefined;
  }
}

/** Пакет → текст для QR / сообщения. Подпись (sig) добавляется автоматически,
 *  если пакет ещё не подписан. Роль отправителя подставляется из текущей сессии. */
export async function encodePacket(p: SyncPacket): Promise<string> {
  const withRole: SyncPacket = p.role ? p : { ...p, role: currentSenderRole() };
  const signed: SyncPacket = withRole.sig ? withRole : { ...withRole, sig: await signPacket(withRole) };
  const json = JSON.stringify(signed);
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

/** Максимум символов в одном кадре QR (с запасом под уровень коррекции M) */
export const QR_CHUNK_SIZE = 1200;

/**
 * Многокадровый QR. Формат кадра: LIPM:<id>:<i>/<n>:<частьbase64>
 * id — короткая сигнатура (длина+префикс payload), чтобы приёмник собирал кадры одного пакета.
 * Одиночные пакеты (LIP:...) остаются совместимыми со старыми версиями.
 */
export function toQrChunks(encoded: string, chunkSize = QR_CHUNK_SIZE): string[] {
  const body = encoded.startsWith(PACKET_PREFIX) ? encoded.slice(PACKET_PREFIX.length) : encoded;
  if (body.length <= chunkSize) return [encoded]; // маленький пакет — один кадр, старый формат
  const id = `${body.length.toString(36)}-${body.slice(0, 8)}${body.slice(-8)}`;
  const chunks: string[] = [];
  const n = Math.ceil(body.length / chunkSize);
  for (let i = 0; i < n; i++) {
    chunks.push(`LIPM:${id}:${i}/${n}:${body.slice(i * chunkSize, (i + 1) * chunkSize)}`);
  }
  return chunks;
}

/** Кэш сборки многокадровых пакетов (id → части по индексам) */
const multiFrameCache = new Map<string, { total: number; parts: Map<number, string>; startedAt: number }>();

/** Собрать кадр(ы) QR/текста в пакет. Поддерживает одиночные LIP:... и многокадровые LIPM:... */
export function decodePacketFromQr(text: string): SyncPacket | null {
  const t = text.trim();
  if (!t.startsWith('LIPM:')) return decodePacket(t);
  try {
    const rest = t.slice('LIPM:'.length);
    const sepId = rest.indexOf(':');
    const sepNum = rest.indexOf(':', sepId + 1);
    if (sepId === -1 || sepNum === -1) return null;
    const id = rest.slice(0, sepId);
    const frac = rest.slice(sepId + 1, sepNum);
    const part = rest.slice(sepNum + 1).trim().split(/\s+/)[0];
    const [idxStr, totStr] = frac.split('/');
    const idx = parseInt(idxStr, 10);
    const total = parseInt(totStr, 10);
    if (isNaN(idx) || isNaN(total) || total < 1 || idx >= total) return null;
    let entry = multiFrameCache.get(id);
    if (!entry) {
      entry = { total, parts: new Map(), startedAt: Date.now() };
      multiFrameCache.set(id, entry);
      // чистка старых незавершённых сборок (старше 5 минут)
      for (const [k, v] of multiFrameCache) {
        if (Date.now() - v.startedAt > 5 * 60 * 1000) multiFrameCache.delete(k);
      }
    }
    entry.parts.set(idx, part);
    if (entry.parts.size < entry.total) return null; // ждём остальные кадры
    let b64 = '';
    for (let i = 0; i < entry.total; i++) {
      const p = entry.parts.get(i);
      if (!p) return null;
      b64 += p;
    }
    multiFrameCache.delete(id);
    return decodePacket(PACKET_PREFIX + b64);
  } catch {
    return null;
  }
}
