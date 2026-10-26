// Безопасность офлайн-цепочки: хеширование паролей + подпись пакетов (HMAC-SHA256).
// WebCrypto доступен и в браузере, и внутри WebView Capacitor.

import { SyncPacket } from './types';

const te = new TextEncoder();

/** Ключ цеха (символический пароль) — общий для всех устройств одного производства.
 *  Вводится начальником производства один раз при первом запуске и хранится локально.
 *  Без него пакеты не подписать/не проверить → чужое устройство с другим ключом не сможет
 *  подменить задания, пользователей или forced-обновления. */
const KEY_STORE = 'workshop-hmac-key-v1';

export function getWorkshopKey(): string {
  return localStorage.getItem(KEY_STORE) || '';
}

export function setWorkshopKey(key: string): void {
  localStorage.setItem(KEY_STORE, key.trim());
}

async function hmacSecret(): Promise<CryptoKey> {
  const key = getWorkshopKey() || 'LIP-default-dev-key'; // dev-режим до ввода ключа
  return crypto.subtle.importKey('raw', te.encode(key), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}

function b64url(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Каноническая строка для подписи: только значимые поля пакета. */
export function packetSigningString(p: SyncPacket): string {
  return JSON.stringify({
    v: p.v, type: p.type, stage: p.stage ?? null,
    payload: p.payload, from: p.from, ts: p.ts,
    forced: p.forced ?? false, role: p.role ?? null,
  });
}

/** Подписать пакет (вызывается в encodePacket перед отправкой). */
export async function signPacket(p: SyncPacket): Promise<string> {
  const sig = await crypto.subtle.sign('HMAC', await hmacSecret(), te.encode(packetSigningString(p)));
  return b64url(sig);
}

/** Проверить подпись пакета. true — если подпись совпадает с нашим ключом. */
export async function verifyPacketSig(p: SyncPacket): Promise<boolean> {
  if (!p.sig) return false;
  try {
    const expected = await signPacket(p);
    return expected === p.sig;
  } catch {
    return false;
  }
}

// ─── Хеширование паролей (PBKDF2-SHA256, соль на пользователя) ───────────────

/** Захешировать пароль: "pbkdf2$итерации$соль$хеш" (все части base64). */
export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iterations = 100_000;
  const baseKey = await crypto.subtle.importKey('raw', te.encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations, hash: 'SHA-256' },
    baseKey, 256,
  );
  const saltB64 = btoa(String.fromCharCode(...salt));
  const hashB64 = b64url(bits);
  return `pbkdf2$${iterations}$${saltB64}$${hashB64}`;
}

/** Проверить пароль против stored-хеша. */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  try {
    const [tag, iterS, saltB64, hashB64] = stored.split('$');
    if (tag !== 'pbkdf2') return false;
    const iterations = parseInt(iterS, 10);
    const salt = Uint8Array.from(atob(saltB64), (c) => c.charCodeAt(0));
    const baseKey = await crypto.subtle.importKey('raw', te.encode(password), 'PBKDF2', false, ['deriveBits']);
    const bits = await crypto.subtle.deriveBits(
      { name: 'PBKDF2', salt, iterations, hash: 'SHA-256' },
      baseKey, 256,
    );
    return b64url(bits) === hashB64;
  } catch {
    return false;
  }
}

/** Выглядит ли значение как старый открытый пароль (не хеш)? */
export function isLegacyPlainPassword(stored: string): boolean {
  return !stored.startsWith('pbkdf2$');
}

/**
 * Однократная миграция открытых паролей в хеши (PBKDF2).
 * Безопасно вызывать при каждом старте: пропускает уже захешированные записи.
 */
export async function migratePasswords(dbUsers: {
  toArray: () => Promise<Array<{ id: string; password?: string }>>;
  update: (id: string, changes: { password: string }) => Promise<any>;
}): Promise<number> {
  let migrated = 0;
  const users = await dbUsers.toArray();
  for (const u of users) {
    if (u.password && isLegacyPlainPassword(u.password)) {
      const hashed = await hashPassword(u.password);
      await dbUsers.update(u.id, { password: hashed });
      migrated++;
    }
  }
  return migrated;
}
