import { z } from "zod";
export const rollId = z.guid(),
  rollQuantity = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
  rollText = z
    .string()
    .min(1)
    .max(2000)
    .refine((v) => !!v.trim());
export const rollCommon = z.object({
  operationId: rollId,
  deviceId: rollId,
  reason: rollText,
  evidence: rollText,
});
export const coatedOutput = rollCommon
  .extend({
    productionBatchId: rollId,
    stepNumber: rollQuantity.max(2147483647),
    slurryConsumptionIds: z.array(rollId).min(1).max(100),
    foilConsumptionIds: z.array(rollId).min(1).max(100),
    outputs: z
      .array(
        z
          .object({
            id: rollId,
            materialId: rollId,
            label: rollText.max(200),
            measuredLengthMm: rollQuantity,
            measuredMassMg: rollQuantity.nullable(),
            disposition: z.enum(["ready", "held"]),
          })
          .strict(),
      )
      .min(1)
      .max(100),
    tape: z.discriminatedUnion("status", [
      z
        .object({ status: z.literal("not_applicable"), note: rollText })
        .strict(),
      z
        .object({
          status: z.literal("unmeasured"),
          issueIds: z.array(rollId).min(1).max(100),
          note: rollText,
        })
        .strict(),
    ]),
    scrapLengthMm: z
      .number()
      .int()
      .min(0)
      .max(Number.MAX_SAFE_INTEGER)
      .nullable(),
    scrapMassMg: z
      .number()
      .int()
      .min(0)
      .max(Number.MAX_SAFE_INTEGER)
      .nullable(),
    accountingNote: rollText,
    observedAt: z.number().finite().positive(),
    specificationReference: rollText,
    reference: rollText,
  })
  .strict();
export const rollPage = z.object({
  deviceId: rollId,
  after: rollId.optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});
export const rollZero = "00000000-0000-0000-0000-000000000000";
export const rollJoins = `JOIN production_batches b ON b.organization_id=c.organization_id AND b.id=c.production_batch_id JOIN production_orders o ON o.organization_id=b.organization_id AND o.id=b.order_id JOIN process_route_steps s ON s.organization_id=o.organization_id AND s.route_id=o.route_id AND s.route_version=o.route_version AND s.step_number=c.step_number AND s.electrode_line=CASE WHEN b.material_line='cell' THEN 'common' ELSE b.material_line END`;
export const rollScope = `($3='chief' OR (c.actor_id=$4 OR $3='master') AND EXISTS(SELECT 1 FROM user_workshop_memberships w WHERE w.organization_id=c.organization_id AND w.user_id=$4 AND w.workshop_id=s.workshop_id))`;
