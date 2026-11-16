import { z } from "zod";
const dimension = z
  .string()
  .regex(/^(?:0|[1-9][0-9]{0,11})(?:\.[0-9]{1,12})?$/)
  .refine((value) => /[1-9]/.test(value));
export const tapeSpecification = z
  .object({
    application: z.enum([
      "coating_support",
      "assembly_tab_insulation",
      "assembly_winding",
    ]),
    widthMm: dimension,
    thicknessUm: dimension,
    reference: z
      .string()
      .min(1)
      .max(200)
      .refine((value) => value.trim() === value),
  })
  .strict();
export function tapeStage(application: string): "coating" | "assembly" {
  return application === "coating_support" ? "coating" : "assembly";
}
