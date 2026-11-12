// Единый офлайн-формат пакета для Bluetooth / QR / текста.
// JSON → base64 (префикс "LIP:"). При автоподхвате из текста ищем подстроку LIP:...

import { SyncPacket, UserRole } from '../core/types';
import { signPacket, hasWorkshopKey } from '../core/security';
import { db } from '../core/db';
import { useAuthStore, currentLocalSession } from '../core/store/authStore';
import { validEnvelope, unsafeLegacyWrite, MAX_PACKET_BYTES, MAX_ENCODED_CHARS, MAX_FRAME_PART, MAX_FRAMES, MAX_ASSEMBLIES, MAX_ASSEMBLY_CHARS, FRAME_TTL_MS } from './packetPolicy';

export const PACKET_PREFIX = 'LIP:';

/** Verified local session attribution; this is not remote proof of a role. */
export function currentSenderRole(): UserRole | undefined {
  const state = useAuthStore.getState();
  return state.sessionChecked && state.isAuthenticated && currentLocalSession(state.session)
    ? state.currentUser?.role : undefined;
}

/** The legacy HMAC transfer channel cannot grant access to server-owned
 * tasks. Reject task/status exports that would bypass server task permissions.
 * Local-only demo transfers continue to use the legacy QR/Bluetooth format. */
function transferredTaskId(packet: SyncPacket): string | null {
  const payload = packet.payload;
  if (!payload || typeof payload !== 'object') return null;
  const value = payload as Record<string, unknown>;
  const id = packet.type === 'task' ? value.id :
    packet.type === 'result' ? value.taskId :
    packet.type === 'forced-push' && 'title' in value && 'status' in value && 'createdBy' in value ? value.id : null;
  return typeof id === 'string' ? id : null;
}

/** Пакет → текст для QR / сообщения. Подпись (sig) добавляется автоматически,
 *  если пакет ещё не подписан. Роль отправителя подставляется из текущей сессии.
 *  Бросает ошибку, если ключ цеха не задан — неподписанные пакеты не выпускаем. */
export async function encodePacket(p: SyncPacket): Promise<string> {
  const taskId = transferredTaskId(p);
  if (taskId) {
    const [revision, queued] = await Promise.all([
      db.hybridTaskRevisions.get(taskId),
      db.hybridTaskOutbox.where('entityId').equals(taskId).count(),
    ]);
    if (revision || queued) {
      throw new Error('Серверное задание нельзя передавать через QR/Bluetooth: используйте защищённую синхронизацию');
    }
  }
  if (!validEnvelope(p)) throw new Error('Некорректный пакет');
  const blocked = unsafeLegacyWrite(p);
  if (blocked) throw new Error(blocked);
  if (!hasWorkshopKey()) {
    throw new Error('Ключ цеха не задан: задайте его в разделе «Синхронизация», чтобы подписывать пакеты');
  }
  const withRole: SyncPacket = p.role ? p : { ...p, role: currentSenderRole() };
  const signed: SyncPacket = withRole.sig ? withRole : { ...withRole, sig: await signPacket(withRole) };
  const json = JSON.stringify(signed);
  if (new TextEncoder().encode(json).length > MAX_PACKET_BYTES) throw new Error('Пакет слишком большой');
  // btoa не любит кириллицу — сначала в UTF-8 escape
  const utf8 = unescape(encodeURIComponent(json));
  return PACKET_PREFIX + btoa(utf8);
}

/** Текст (из QR/сообщения) → пакет; null если это не наш пакет */
export function decodePacket(text: string): SyncPacket | null {
  try {
    if (text.length > MAX_ENCODED_CHARS + 4096) return null;
    const idx = text.indexOf(PACKET_PREFIX);
    if (idx < 0 || idx > 4096) return null;
    let b64 = text.slice(idx + PACKET_PREFIX.length).trim().split(/\s+/)[0];
    if (!b64 || b64.length > MAX_ENCODED_CHARS || !/^[A-Za-z0-9+/]*={0,2}$/.test(b64)) return null;
    while (b64.length % 4) b64 += '=';
    const bytes = atob(b64);
    if (bytes.length > MAX_PACKET_BYTES) return null;
    const obj: unknown = JSON.parse(decodeURIComponent(escape(bytes)));
    return validEnvelope(obj) ? obj : null;
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
  if (!Number.isInteger(chunkSize) || chunkSize < 1 || chunkSize > MAX_FRAME_PART) throw new Error('Некорректный размер кадра QR');
  const body = encoded.startsWith(PACKET_PREFIX) ? encoded.slice(PACKET_PREFIX.length) : encoded;
  if (body.length > MAX_ENCODED_CHARS || Math.ceil(body.length / chunkSize) > MAX_FRAMES) throw new Error('Слишком большой пакет QR');
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
const multiFrameCache = new Map<string, { total: number; parts: Map<number, string>; startedAt: number; chars: number }>();

/** Assemble bounded, consistent frames; an invalid/conflicting assembly is discarded. */
export function decodePacketFromQr(text: string): SyncPacket | null {
  const now = Date.now();
  for (const [id, entry] of multiFrameCache) {
    if (now - entry.startedAt >= FRAME_TTL_MS) multiFrameCache.delete(id);
  }
  if (text.length > MAX_ENCODED_CHARS + 4096) return null;
  const t = text.trim();
  if (!t.startsWith('LIPM:')) return decodePacket(t);
  if (t.length > MAX_FRAME_PART + 128) return null;
  const match = /^LIPM:([A-Za-z0-9+/_=-]{1,96}):(\d{1,4})\/(\d{1,4}):([A-Za-z0-9+/=]+)$/.exec(t);
  if (!match) return null;
  const [, id, indexText, totalText, part] = match;
  const index = Number(indexText), total = Number(totalText);
  if (total < 1 || total > MAX_FRAMES || index >= total || part.length > MAX_FRAME_PART) return null;
  let entry = multiFrameCache.get(id);
  if (entry && (entry.total !== total || entry.parts.has(index) && entry.parts.get(index) !== part)) {
    multiFrameCache.delete(id);
    return null;
  }
  if (!entry) {
    if (multiFrameCache.size >= MAX_ASSEMBLIES) multiFrameCache.delete(multiFrameCache.keys().next().value!);
    entry = { total, parts: new Map(), startedAt: now, chars: 0 };
    multiFrameCache.set(id, entry);
  }
  if (!entry.parts.has(index)) {
    const aggregate = [...multiFrameCache.values()].reduce((sum, item) => sum + item.chars, 0);
    if (entry.chars + part.length > MAX_ENCODED_CHARS || aggregate + part.length > MAX_ASSEMBLY_CHARS) {
      multiFrameCache.delete(id);
      return null;
    }
    entry.parts.set(index, part);
    entry.chars += part.length;
  }
  if (entry.parts.size < total) return null;
  const body = Array.from({ length: total }, (_, i) => entry!.parts.get(i)!).join('');
  multiFrameCache.delete(id);
  return decodePacket(PACKET_PREFIX + body);
}
