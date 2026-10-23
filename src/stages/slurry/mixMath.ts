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

// ─────────────────────────────────────────────────────────────────────────────
// Расчётные модели пасты (замеса): твёрдые вещества, плотность, реология
// Все модели — чисто офлайн-математика, вход: рецепт + база компонентов.
// ─────────────────────────────────────────────────────────────────────────────

/** Реологическая модель для расчёта вязкости */
export type ViscosityModelId = 'einstein' | 'maronpearson' | 'mooney' | 'cross';

export const VISCOSITY_MODELS: Record<ViscosityModelId, { name: string; formula: string; note: string }> = {
  einstein: {
    name: 'Айзенштейн (Einstein, 1906)',
    formula: 'η = η₀ · (1 + 2,5·φ)',
    note: 'Базовая модель разбавленных суспензий сферических частиц (φ < ~0,03). Нижняя граница оценки.',
  },
  maronpearson: {
    name: 'Марон–Пирсон (Maron–Pierce / Krieger–Dougherty, 1956)',
    formula: 'η = η₀ · (1 − φ/φm)^(−2,5·φm)',
    note: 'Стандарт для концентрированных суспензий; при малых φ сводится к Айзенштейну. Используется в реологии battery slurry (Ledergerber & Balaich, 2014).',
  },
  mooney: {
    name: 'Муни (Mooney, 1951)',
    formula: 'ln(η/η₀) = 2,5·φ / (1 − φ/φm)',
    note: 'Эмпирика для вязкоупругих систем (полимер + частицы); хорошо ложится на шлам PVDF/CNT.',
  },
  cross: {
    name: 'Кросс (Cross, 1965)',
    formula: 'η(γ̇) = η∞ + (η₀ − η∞)/(1 + (γ̇/γ̇c)ᵐ)',
    note: 'Сдвиговое разжижение (псевдопластичность): вязкость падает с ростом скорости сдвига γ̇ — именно это показывает ротационный вискозиметр.',
  },
};

export interface PasteProperties {
  // Состав и массы
  solidsMassG: number;        // масса сухих веществ, г
  liquidMassG: number;        // масса жидкой фазы (растворители), г
  totalMassG: number;         // полная масса замеса, г
  // Содержание твёрдых веществ
  solidsPctMass: number;      // массовое содержание СВ, %
  solidsPctVol: number;       // объёмное содержание СВ (φ_насыщ. без утряски), %
  packingFraction: number;    // φ — коэффициент упаковки твёрдой фазы в объёме пасты (0..1)
  // Плотности
  trueDensitySolid: number;   // средняя истинная плотность СВ, г/см³ (по массовой норме)
  bulkDensitySolid: number;   // средняя плотность утряски СВ, г/см³
  densityLiquid: number;      // плотность жидкой фазы, г/см³
  pasteDensity: number;       // расчётная плотность пасты, г/см³
  pasteVolumeCm3: number;     // расчётный объём замеса, см³ (л = /1000)
  porosityAtPacking: number;  // пористость (зазор между частицами) при текущей упаковке, %
  maxSolidsPctMass: number;   // максимально достижимое содержание СВ по массе при φm
  // Вязкость
  baseViscosityPas: number;   // η₀ — вязкость чистой жидкой фазы, Па·с
  etaRel: Record<ViscosityModelId, number>; // относительная вязкость η/η₀ по каждой модели
  etaAbs: Record<ViscosityModelId, number>; // абсолютная вязкость, мПа·с (сП)
  shearThinning?: { gammaDot: number; mPa_s: number }; // Кросс при опорном сдвиге
}

const PHI_M_DEFAULT = 0.62; // типичная максимальная упаковка полидисперсных частиц

/** Средняя вязкость жидкой фазы по растворителям (массовое усреднение ln — стандарт для смесей) */
function blendLiquidViscosity(wetRows: GrammageRow[], compMap: Map<string, MixComponent>): number {
  const items = wetRows
    .map((r) => ({ g: r.grams, v: compMap.get(r.componentId)?.viscosity }))
    .filter((x) => x.v && x.v > 0) as { g: number; v: number }[];
  if (!items.length) return 0.001; // ≈ вода при 25°C, Па·с
  const tot = items.reduce((s, x) => s + x.g, 0) || 1;
  const lnMix = items.reduce((s, x) => s + (x.g / tot) * Math.log(x.v / 1000), 0); // мПа·с → Па·с
  return Math.exp(lnMix);
}

function blendLiquidDensity(wetRows: GrammageRow[], compMap: Map<string, MixComponent>): number {
  const items = wetRows
    .map((r) => ({ g: r.grams, d: compMap.get(r.componentId)?.densityTrue }))
    .filter((x) => x.d && x.d > 0) as { g: number; d: number }[];
  if (!items.length) return 1.0;
  const tot = items.reduce((s, x) => s + x.g, 0) || 1;
  // объёмное усреднение через удельные объёмы
  const invRho = items.reduce((s, x) => s + (x.g / tot) / x.d, 0);
  return 1 / invRho;
}

/**
 * Полный расчёт свойств пасты из рецепта и граммовок.
 * @param rows     результат calcGrammages (rows + итоги)
 * @param compMap  база компонентов
 * @param opts     φm (макс. упаковка), скорость сдвига для модели Кросса
 */
export function calcPasteProperties(
  rows: GrammageRow[],
  compMap: Map<string, MixComponent>,
  opts: { phiMax?: number; shearRate?: number } = {},
): PasteProperties | null {
  const dryRows = rows.filter((r) => !r.isSolvent);
  const wetRows = rows.filter((r) => r.isSolvent);
  if (!dryRows.length) return null;

  const phiMax = opts.phiMax && opts.phiMax > 0.05 && opts.phiMax < 0.95 ? opts.phiMax : PHI_M_DEFAULT;
  const shearRate = opts.shearRate && opts.shearRate > 0 ? opts.shearRate : 50; // 1/с — типовой рабочий сдвиг

  const solidsMassG = dryRows.reduce((s, r) => s + r.grams, 0);
  const liquidMassG = wetRows.reduce((s, r) => s + r.grams, 0);
  const totalMassG = solidsMassG + liquidMassG;
  if (solidsMassG <= 0 || totalMassG <= 0) return null;

  // Истинные плотности СВ (объёмное усреднение через массы)
  let solidVolCm3 = 0;
  let settledAcc = 0, settledW = 0;
  for (const r of dryRows) {
    const c = compMap.get(r.componentId);
    const rho = c?.densityTrue;
    solidVolCm3 += rho && rho > 0 ? r.grams / rho : 0;
    if (c?.densitySettled && c.densitySettled > 0) { settledAcc += r.grams / c.densitySettled; settledW += r.grams; }
  }
  // Компоненты без указанной плотности считаем как ρ=3 г/см³ (типично для оксидов), чтобы оценка не «плыла»
  const missing = dryRows.filter((r) => { const c = compMap.get(r.componentId); return !c?.densityTrue || !(c.densityTrue > 0); });
  if (missing.length) solidVolCm3 += missing.reduce((s, r) => s + r.grams / 3.0, 0);

  const rhoLiquid = blendLiquidDensity(wetRows, compMap);
  const liquidVolCm3 = liquidMassG / rhoLiquid;
  const pasteVolumeCm3 = solidVolCm3 + liquidVolCm3;

  const trueDensitySolid = solidsMassG / (solidVolCm3 || 1);
  const bulkDensitySolid = settledW ? solidsMassG / (settledAcc || 1) : NaN;
  const pasteDensity = totalMassG / (pasteVolumeCm3 || 1);

  const phi = solidVolCm3 / (pasteVolumeCm3 || 1);           // объёмная доля СВ = коэффициент упаковки
  const solidsPctMass = (solidsMassG / totalMassG) * 100;
  const porosity = Math.max(0, (1 - phi)) * 100;

  // Максимально достижимое % СВ по массе при φm:
  // φm = Vтв/(Vтв+Vж) → Vж = Vтв(1-φm)/φm → mж = Vж·ρж → w_max = mтв/(mтв+mж)
  const vmaxLiquid = solidVolCm3 * (1 - phiMax) / phiMax;
  const maxSolidsPctMass = (solidsMassG / (solidsMassG + vmaxLiquid * rhoLiquid)) * 100;

  // Базовая вязкость жидкой фазы
  const eta0 = blendLiquidViscosity(wetRows, compMap); // Па·с

  // Относительные вязкости моделей (при φ ≥ φm — «бесконечность», капацитивный предел)
  const clampedPhi = Math.min(phi, phiMax * 0.999);
  const einstein = 1 + 2.5 * phi;
  const maronpearson = Math.pow(1 - phi / phiMax, -2.5 * phiMax);
  const mooney = Math.exp((2.5 * clampedPhi) / (1 - clampedPhi / phiMax));

  // Кросс (1965): η(γ̇)=η∞+(η₀−η∞)/(1+(γ̇/γ̇c)^m); для battery slurry: m≈0.75, γ̇c≈10 1/с.
  const mExp = 0.75, critShear = 10;
  const etaZeroRel = maronpearson;  // вязкость при нулевом сдвиге — по Марон–Пирсон (самая физичная)
  const etaInfRel = Math.max(einstein, 1 + 2.5 * phi * 0.15); // высоко-сдвиговый предел
  const crossRel = (shearRate: number) =>
    etaInfRel + (etaZeroRel - etaInfRel) / (1 + Math.pow(shearRate / critShear, mExp));

  // Пересчёт в мПа·с: базовая вязкость η₀ жидкой фазы хранится в Па·с (умножить на 1000).
  // Если в базе не указана вязкость растворителя — берём типовое значение растворителя шлама
  // (вода ≈ 0.89 мПа·с), иначе получаем абсурдные единицы сП.
  const hasLiquidViscosity = wetRows.some((r) => { const v = compMap.get(r.componentId)?.viscosity; return !!v && v > 0; });
  const eta0Cp = hasLiquidViscosity ? eta0 * 1000 : 0.89;
  const toCp = (rel: number) => rel * eta0Cp; // безразмерная × мПа·с → мПа·с (сП)

  return {
    solidsMassG, liquidMassG, totalMassG,
    solidsPctMass, solidsPctVol: phi * 100, packingFraction: phi,
    trueDensitySolid, bulkDensitySolid, densityLiquid: rhoLiquid,
    pasteDensity, pasteVolumeCm3, porosityAtPacking: porosity, maxSolidsPctMass,
    baseViscosityPas: eta0,
    etaRel: { einstein, maronpearson, mooney, cross: crossRel(shearRate) },
    etaAbs: {
      einstein: toCp(einstein),
      maronpearson: toCp(maronpearson),
      mooney: toCp(mooney),
      cross: toCp(crossRel(shearRate)),
    },
    shearThinning: { gammaDot: shearRate, mPa_s: toCp(crossRel(shearRate)) },
  };
}
