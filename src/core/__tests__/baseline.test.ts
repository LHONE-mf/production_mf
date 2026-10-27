import { describe, it, expect, beforeEach } from "vitest";
import { encodePacket, decodePacket } from "../../transfer/packet";
import { setWorkshopKey } from "../security";

// Формат SyncPacket: { v:1, type, payload, ... }. См. src/core/types/domains/transfer.ts
const sample = { v: 1 as const, type: "task" as any, id: "t-1", payload: { title: "Проверка" }, updatedAt: Date.now() };

describe("packet encode/decode (baseline)", () => {
  beforeEach(() => {
    localStorage.clear();
    setWorkshopKey("test-workshop-key"); // с Э1 пакеты выпускаются только подписанными
  });

  it("roundtrip: пакет проходит через LIP-формат", async () => {
    const text = await encodePacket(sample as never);
    expect(text.startsWith("LIP:")).toBe(true);
    const decoded = decodePacket(text);
    expect(decoded).toBeTruthy();
    expect((decoded as any).id).toBe("t-1");
  });
  it("битый пакет возвращает null, а не падает", () => {
    expect(decodePacket("LIP:%%%не-base64%%%")).toBeNull();
    expect(decodePacket("привет без префикса")).toBeNull();
  });
});
