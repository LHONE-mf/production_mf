// Меш-логика офлайн-чата: ретрансляция, дедупликация, автоприём.
// Работает поверх любого транспорта (Bluetooth / QR / текст) — везде один
// и тот же LIP-пакет с типом 'chat'.

import { db } from '../core/db';
import { SyncPacket, ChatMessage, CHAT_MAX_HOPS } from '../core/types';
import { applyPacket } from '../transfer/apply';

/** Окно «живого» сообщения: пока ttl > 0 и сообщение свежее этого окна — ретранслируем */
export const RELAY_WINDOW_MS = 10 * 60 * 1000; // 10 минут

/** Уменьшить ttl пакета при пересылке через промежуточный узел mesh */
export function decrementTtl(packet: SyncPacket): SyncPacket {
  if (packet.type !== 'chat') return packet;
  const m = packet.payload as ChatMessage;
  return { ...packet, payload: { ...m, ttl: Math.max(0, (m.ttl ?? CHAT_MAX_HOPS) - 1) } };
}

/** Можно ли ещё ретранслировать это сообщение? */
export function canRelay(m: ChatMessage): boolean {
  return (m.ttl ?? 0) > 0 && Date.now() - m.ts < RELAY_WINDOW_MS;
}

/** Применить входящий пакет чата и вернуть его для возможной ретрансляции (или null) */
export async function ingestChatPacket(p: SyncPacket): Promise<{ applied: boolean; relayPacket: SyncPacket | null }> {
  const res = await applyPacket(p);
  if (!res.ok || p.type !== 'chat') return { applied: res.ok, relayPacket: null };
  const decremented = decrementTtl(p);
  const dm = decremented.payload as ChatMessage;
  // Ретранслируем только если ttl ещё положительный и сообщение свежее окна
  const relayPacket = canRelay(dm) ? decremented : null;
  return { applied: true, relayPacket };
}

/** Отдать все «живые» сообщения для раздачи новому узлу (sync-on-connect) */
export async function getRelayableMessages(): Promise<SyncPacket[]> {
  const now = Date.now();
  const all = await db.chatMessages.toArray();
  const fresh = all.filter((m) => now - m.ts < RELAY_WINDOW_MS);
  // отсортируем по времени, ограничим размер выдачи
  fresh.sort((a, b) => a.ts - b.ts);
  const take = fresh.slice(-30);
  return take.map((m) => ({
    v: 1 as const,
    type: 'chat' as const,
    payload: m,
    from: m.from,
    ts: m.ts,
  }));
}
