import { expect, it } from "vitest";
import { material } from "./inventoryCatalogClient";
import { validTapeSpecification, sameTapeSpecification } from "./inventoryTape";
const spec = {
  application: "coating_support",
  widthMm: "12.50",
  thicknessUm: "25.00",
  reference: "Synthetic supplier drawing R2",
};
it("keeps exact declared dimensions and one explicit tape application per roll SKU", () => {
  const sku = {
    id: "11111111-1111-4111-8111-111111111111",
    code: "TAPE",
    name: "Synthetic tape",
    category: "component",
    baseUnit: "rolls",
    tapeSpecification: spec,
  };
  expect(material(sku)).toBe(true);
  for (const application of [
    "coating_support",
    "assembly_tab_insulation",
    "assembly_winding",
  ])
    expect(validTapeSpecification({ ...spec, application })).toBe(true);
  for (const patch of [
    { baseUnit: "pieces" },
    { baseUnit: "mm" },
    { category: "raw_material" },
    { tapeSpecification: { ...spec, widthMm: 12.5 } },
    { tapeSpecification: { ...spec, application: "slurry" } },
  ])
    expect(material({ ...sku, ...patch })).toBe(false);
  for (const widthMm of [
    "0",
    "0.000",
    "-1",
    "1e2",
    "1,5",
    " 1",
    "01",
    "NaN",
    "1.".padEnd(50, "1"),
  ])
    expect(validTapeSpecification({ ...spec, widthMm })).toBe(false);
  expect(validTapeSpecification({ ...spec, rollLength: 100 })).toBe(false);
  expect(
    sameTapeSpecification(spec, {
      reference: spec.reference,
      thicknessUm: "25.00",
      widthMm: "12.50",
      application: "coating_support",
    }),
  ).toBe(true);
  expect(sameTapeSpecification(spec, { ...spec, widthMm: "12.5" })).toBe(false);
});
