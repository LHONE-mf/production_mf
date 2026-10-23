// Математика комнаты замесов: расчёт граммовок по рецепту на произвольную массу.
// Логика вынесена отдельно от React — чтобы её можно было тестировать и переиспользовать.

import { MixRecipe, MixComponent, MixRecipeLine } from '../../core/types';

export interface GrammageRow {
  componentId: string;
  name: string;
  kind: MixComponent['kind'];
  pct: number;          // доля из рецепта, %
  isSolvent: boolean;   // растворитель/добавка-жидкость (считается от массы СВ)
  grams: number;        // расчётная граммовка, г
}

/** Сухие вещества = все компоненты кроме растворителей */
export function splitLines(lines: MixRecipeLine[], components: Map<string, MixComponent>) {
  const dry: MixRecipeLine[] = [];
  const wet: MixRecipeLine[] = [];
  for (const l of lines) {
    const c = components.get(l.componentId);
    (c?.kind === 'solvent' ? wet : dry).push(l);
  }
  return { dry, wet };
}

/**
 * Расчёт граммовок.
 * @param recipe     стандартный замес (или его снимок)
 * @param components база компонентов (id → компонент)
 * @param batchKg    масса замеса по сухим веществам, кг (масштаб относительно recipe.dryMassKg не требуется —
 *                   проценты сухих нормируются на сумму, растворитель задан % от массы СВ)
 * @returns строки таблицы + итоги
 */
export function calcGrammages(
  recipe: Pick<MixRecipe, 'lines'>,
  components: Map<string, MixComponent>,
  batchKg: number,
): { rows: GrammageRow[]; dryTotalG: number; wetTotalG: number; allTotalG: number; solidsPct: number } {
  const { dry, wet } = splitLines(recipe.lines, components);

  const dryPctSum = dry.reduce((s, l) => s + l.pct, 0) || 1;
  const dryTotalG = batchKg * 1000; // масса СВ в граммах

  const rows: GrammageRow[] = [];
  // Сухие: доли нормируем на их сумму → строго batchKg суммарно
  for (const l of dry) {
    const c = components.get(l.componentId);
    rows.push({
      componentId: l.componentId,
      name: c?.name ?? '(компонент удалён)',
      kind: c?.kind ?? 'additive',
      pct: l.pct,
      isSolvent: false,
      grams: (dryTotalG * l.pct) / dryPctSum,
    });
  }
  // Растворители: % от фактической массы СВ
  let wetTotalG = 0;
  for (const l of wet) {
    const c = components.get(l.componentId);
    const g = (dryTotalG * l.pct) / 100;
    wetTotalG += g;
    rows.push({
      componentId: l.componentId,
      name: c?.name ?? '(компонент удалён)',
      kind: c?.kind ?? 'solvent',
      pct: l.pct,
      isSolvent: true,
      grams: g,
    });
  }

  const allTotalG = dryTotalG + wetTotalG;
  return {
    rows,
    dryTotalG,
    wetTotalG,
    allTotalG,
    solidsPct: (dryTotalG / allTotalG) * 100,
  };
}

export const fmtG = (g: number) =>
  g >= 1000 ? `${(g / 1000).toFixed(3)} кг` : `${g.toFixed(1)} г`;
