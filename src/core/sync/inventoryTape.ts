/** Declared SKU dimensions, not conversions or measured roll remainders. */
export const tapeApplications = {
  coating_support: "Coating · временная опорная лента",
  assembly_tab_insulation: "Assembly · изоляция выводов",
  assembly_winding: "Assembly · фиксация рулона электродов",
};
export interface TapeSpecification {
  application: keyof typeof tapeApplications;
  widthMm: string;
  thicknessUm: string;
  reference: string;
}
const dimension = (value: unknown): value is string =>
  typeof value === "string" &&
  /^(?:0|[1-9][0-9]{0,11})(?:\.[0-9]{1,12})?$/.test(value) &&
  /[1-9]/.test(value);
export function validTapeSpecification(
  value: unknown,
): value is TapeSpecification {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const r = value as Record<string, unknown>;
  return (
    Object.keys(r).length === 4 &&
    typeof r.application === "string" &&
    Object.prototype.hasOwnProperty.call(tapeApplications, r.application) &&
    dimension(r.widthMm) &&
    dimension(r.thicknessUm) &&
    typeof r.reference === "string" &&
    r.reference.trim() === r.reference &&
    r.reference.length > 0 &&
    r.reference.length <= 200
  );
}
export function sameTapeSpecification(a: unknown, b: unknown): boolean {
  if (a === undefined && b === undefined) return true;
  return (
    validTapeSpecification(a) &&
    validTapeSpecification(b) &&
    a.application === b.application &&
    a.widthMm === b.widthMm &&
    a.thicknessUm === b.thicknessUm &&
    a.reference === b.reference
  );
}
export function tapeDescription(spec: TapeSpecification): string {
  return `${tapeApplications[spec.application]} · ширина ${spec.widthMm} мм · толщина ${spec.thicknessUm} мкм · ${spec.reference}`;
}
