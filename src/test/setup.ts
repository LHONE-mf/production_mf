// Общая настройка тестов — Этап №0
// IndexedDB в node-среде эмулируется через fake-indexeddb (для тестов Dexie).
import "fake-indexeddb/auto";

// WebCrypto (PBKDF2/HMAC из security.ts) в Node 18+:
if (typeof globalThis.crypto === "undefined" || !globalThis.crypto.subtle) {
  const { webcrypto } = await import("node:crypto");
  // @ts-expect-error типы webcrypto и DOM Crypto различаются по объявлениям
  globalThis.crypto = webcrypto;
}
