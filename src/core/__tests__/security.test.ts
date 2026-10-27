// Тесты безопасности офлайн-цепочки (Этап Э1): подпись пакетов HMAC-SHA256,
// обязательность ключа цеха, отклонение неподписанных/чужих пакетов.
import { describe, it, expect, beforeEach } from "vitest";
import {
  signPacket,
  verifyPacketSig,
  packetSigningString,
  hashPassword,
  verifyPassword,
  isLegacyPlainPassword,
  migratePasswords,
  setWorkshopKey,
  hasWorkshopKey,
} from "../security";
import { encodePacket, decodePacket, toQrChunks, decodePacketFromQr } from "../../transfer/packet";
import { applyPacket } from "../../transfer/apply";
import { SyncPacket, UserRole } from "../types";

const KEY = "цех-ключ-123";

function makePacket(over: Partial<SyncPacket> = {}): SyncPacket {
  return {
    v: 1,
    type: "task",
    payload: { title: "Тест" },
    from: "u-1",
    ts: Date.now(),
    role: UserRole.WORKER,
    ...over,
  };
}

describe("workshop key (Э1)", () => {
  beforeEach(() => localStorage.clear());

  it("без ключа цеха hasWorkshopKey=false, encodePacket бросает ошибку", async () => {
    expect(hasWorkshopKey()).toBe(false);
    await expect(encodePacket(makePacket())).rejects.toThrow(/Ключ цеха/);
  });

  it("с ключом пакеты подписываются и проходят roundtrip", async () => {
    setWorkshopKey(KEY);
    expect(hasWorkshopKey()).toBe(true);
    const text = await encodePacket(makePacket());
    const decoded = decodePacket(text)!;
    expect(decoded.sig).toBeTruthy();
    expect(await verifyPacketSig(decoded)).toBe(true);
  });

  it("setWorkshopKey обрезает пробелы", () => {
    setWorkshopKey("  abc  ");
    expect(localStorage.getItem("workshop-hmac-key-v1")).toBe("abc");
  });
});

describe("signing / verification (Э1)", () => {
  beforeEach(() => {
    localStorage.clear();
    setWorkshopKey(KEY);
  });

  it("подпись зависит от всех значимых полей (каноническая строка)", async () => {
    const p = makePacket();
    const sig = await signPacket(p);
    expect(sig).toBeTruthy();
    // меняем payload — подпись должна перестать подходить
    const tampered = { ...p, payload: { title: "Подделка" } };
    expect(await verifyPacketSig(tampered)).toBe(false);
    expect(packetSigningString(p)).not.toBe(packetSigningString(tampered));
  });

  it("устройство с другим ключом не пройдёт проверку", async () => {
    const sig = await signPacket(makePacket());
    setWorkshopKey("другой-ключ");
    const foreign = { ...makePacket(), sig };
    expect(await verifyPacketSig(foreign)).toBe(false);
  });

  it("verifyPacketSig: false для пакета без sig и с битой sig", async () => {
    expect(await verifyPacketSig(makePacket())).toBe(false);
    expect(await verifyPacketSig({ ...makePacket(), sig: "%%%" })).toBe(false);
  });
});

describe("applyPacket security (Э1)", () => {
  beforeEach(() => {
    localStorage.clear();
    setWorkshopKey(KEY);
  });

  it("отклоняет пакет без подписи", async () => {
    const res = await applyPacket(makePacket());
    expect(res.ok).toBe(false);
    expect(res.message).toMatch(/не подписан/);
  });

  it("отклоняет пакет с чужой подписью", async () => {
    const forged = { ...makePacket(), sig: "sike" };
    const res = await applyPacket(forged);
    expect(res.ok).toBe(false);
    expect(res.message).toMatch(/не совпадает/);
  });

  it("forced-пакет без роли master/chief отклоняется", async () => {
    const p = await sign(makePacket({ forced: true, role: UserRole.WORKER }));
    const res = await applyPacket(p);
    expect(res.ok).toBe(false);
    expect(res.message).toMatch(/forced/);
  });

  it("привилегированный тип user от worker'а отклоняется", async () => {
    const p = await sign(makePacket({ type: "user" as any, payload: { id: "u-9", login: "x", fullName: "X", role: UserRole.WORKER } }));
    const res = await applyPacket(p);
    expect(res.ok).toBe(false);
    expect(res.message).toMatch(/только мастер/);
  });

  it("подписанный journal-пакет применяется", async () => {
    const j = { id: "j-1", stage: "slurry" as any, text: "запись", createdAt: new Date(), updatedAt: Date.now() };
    const p = await sign(makePacket({ type: "journal" as any, payload: j }));
    const res = await applyPacket(p);
    expect(res.ok).toBe(true);
  });
});

/** Подписать пакет текущим ключом цеха (как это делает encodePacket при отправке). */
async function sign(p: SyncPacket): Promise<SyncPacket> {
  return { ...p, sig: await signPacket(p) };
}

describe("password hashing (PBKDF2)", () => {
  it("hash → verify проходит, неверный пароль отклоняется", async () => {
    const stored = await hashPassword("секрет123");
    expect(stored.startsWith("pbkdf2$100000$")).toBe(true);
    expect(await verifyPassword("секрет123", stored)).toBe(true);
    expect(await verifyPassword("секрет124", stored)).toBe(false);
  });

  it("соль уникальна: два хеша одного пароля различаются", async () => {
    expect(await hashPassword("pwd")).not.toBe(await hashPassword("pwd"));
  });

  it("isLegacyPlainPassword распознаёт открытые пароли", () => {
    expect(isLegacyPlainPassword("plain-pass")).toBe(true);
    expect(isLegacyPlainPassword("pbkdf2$100000$AAA$BBB")).toBe(false);
  });

  it("migratePasswords конвертирует открытые пароли в хеши один раз", async () => {
    const rows = [
      { id: "1", password: "plain1" },
      { id: "2", password: "pbkdf2$100000$cw==$aA==" },
    ];
    const updates: Array<{ id: string; password: string }> = [];
    const fakeUsers = {
      toArray: async () => rows,
      update: async (id: string, changes: { password: string }) => {
        updates.push({ id, ...changes });
      },
    };
    const n = await migratePasswords(fakeUsers);
    expect(n).toBe(1);
    expect(updates[0].id).toBe("1");
    expect(updates[0].password.startsWith("pbkdf2$")).toBe(true);
    expect(await verifyPassword("plain1", updates[0].password)).toBe(true);
  });
});

describe("QR multi-frame (LIPM)", () => {
  beforeEach(() => {
    localStorage.clear();
    setWorkshopKey(KEY);
  });

  it("маленький пакет остаётся одиночным LIP:", async () => {
    const text = await encodePacket(makePacket());
    expect(toQrChunks(text)).toEqual([text]);
  });

  it("большой пакет режется на кадры и собирается обратно", async () => {
    const big = makePacket({ payload: { title: "Y".repeat(5000), nums: Array.from({ length: 300 }, (_, i) => i) } });
    const text = await encodePacket(big);
    const chunks = toQrChunks(text, 1200);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) expect(c.startsWith("LIPM:")).toBe(true);
    // кадры приходят вразнобой — сборка завершится только на последнем
    const shuffled = [...chunks].sort(() => Math.random() - 0.5);
    let out: SyncPacket | null = null;
    for (const c of shuffled) out = decodePacketFromQr(c);
    expect(out).toBeTruthy();
    expect((out!.payload as any).title).toBe("Y".repeat(5000));
    expect(await verifyPacketSig(out!)).toBe(true);
  });
});
