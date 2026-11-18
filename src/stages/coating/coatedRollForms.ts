import type { InventoryScope } from "../../core/sync/inventoryOutbox";
import type { HybridSession } from "../../core/sync/hybridClient";
export interface CoatedRollProps {
  session: HybridSession;
  scope: InventoryScope;
  localActorId: string;
}
export const rollFrame =
  "min-w-0 space-y-2 break-words rounded border border-slate-600 p-3";
import { toInventoryBaseUnits } from "../../core/sync/inventoryReceiving";
export function optionalRollMeasure(
  value: string,
  unit: "m" | "g",
  allowZero = false,
): number | null {
  if (!value.trim()) return null;
  if (allowZero && /^0+(?:[.,]0+)?$/.test(value.trim())) return 0;
  return toInventoryBaseUnits(value, unit, unit === "m" ? "mm" : "mg");
}
export function observedRollCount(value: string): number | null {
  if (!value.trim()) return null;
  if (!/^\d+$/.test(value.trim()) || !Number.isSafeInteger(Number(value)))
    throw Error(
      "Укажите фактически посчитанное целое количество или оставьте пустым, если оно неизвестно",
    );
  return Number(value);
}
