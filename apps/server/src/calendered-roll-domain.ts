import { z } from "zod";
import { coatedOutput, rollId } from "./coating-roll-domain.js";
export {
  rollId,
  rollQuantity,
  rollText,
  rollCommon,
  rollPage,
  rollZero,
  rollJoins,
  rollScope,
} from "./coating-roll-domain.js";
export const calenderedOutput = coatedOutput
  .omit({ slurryConsumptionIds: true, foilConsumptionIds: true, tape: true })
  .extend({ consumptionIds: z.array(rollId).min(1).max(100) })
  .strict();
