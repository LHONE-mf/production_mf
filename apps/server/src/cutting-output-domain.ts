import { z } from "zod";
import {
  calenderedOutput,
  rollId,
  rollQuantity,
  rollText,
} from "./calendered-roll-domain.js";
export {
  rollId,
  rollQuantity,
  rollText,
  rollCommon,
  rollPage,
  rollZero,
  rollJoins,
  rollScope,
} from "./calendered-roll-domain.js";
export const cuttingOutput = calenderedOutput
  .omit({ outputs: true })
  .extend({
    unit: z.literal("pieces"),
    rejectedPieces: z
      .number()
      .int()
      .min(0)
      .max(Number.MAX_SAFE_INTEGER)
      .nullable(),
    outputs: z
      .array(
        z
          .object({
            id: rollId,
            materialId: rollId,
            label: rollText.max(200),
            quantity: rollQuantity,
            disposition: z.enum(["ready", "held"]),
          })
          .strict(),
      )
      .min(1)
      .max(100),
  })
  .strict();
