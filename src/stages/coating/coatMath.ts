// Расчётные модели комнаты нанесения покрытия (офлайн, без серверов).
// Всё считается из данных замеса (вязкость, СВ, ρ пасты) + задания на намазку.

/**
 * Ориентировочная ширина щели фильеры (зазор фильера–фольга), мкм.
 * Для щелевой (slot-die) головки объёмный расход Q = w · h · v,
 * где w — ширина полосы, h — зазор, v — скорость ленты.
 * Отсюда h = Q / (w · v). Мокрая толщина ≈ h при контактном нанесении.
 */
export function headGapUm(qCm3PerMin: number, widthCm: number, webSpeedMpm: number): number | null {
  if (!qCm3PerMin || !widthCm || !webSpeedMpm) return null;
  // единицы: см³/мин ÷ (см × м/мин) → см/м = 1e-2 → мкм: ×1e4 / 100... считаем аккуратно:
  // h [см] = Q[см³/мин] / (w[см] · v[см/мин]); v[м/мин] = v·100 см/мин
  const hCm = qCm3PerMin / (widthCm * webSpeedMpm * 100);
  const um = hCm * 1e4;
  return Math.round(um * 10) / 10;
}

/**
 * Требуемая производительность шнекового насоса, л/мин, для заданной мокрой толщины.
 * Q = w · h · v (объём пасты на единицу времени).
 */
export function requiredScrewFlowLpm(widthCm: number, wetThicknessUm: number, webSpeedMpm: number): number | null {
  if (!widthCm || !wetThicknessUm || !webSpeedMpm) return null;
  // w [см] · h [см] · v [см/мин] = см³/мин; h: мкм → см = ×1e-4
  const cm3PerMin = widthCm * wetThicknessUm * 1e-4 * webSpeedMpm * 100;
  return Math.round((cm3PerMin / 1000) * 1000) / 1000; // л/мин
}

/**
 * Оценка оборотов шнекового насоса по расходу и подаче с одного оборота.
 * supplyCm3PerRev — производительность шнека на 1 об/мин (зависит от станка,
 * обычно справочная величина; по умолчанию подбирается демо-значение).
 */
export function screwRpmFromFlow(flowLpm: number | null, supplyCm3PerRev = 25): number | null {
  if (!flowLpm || flowLpm <= 0) return null;
  return Math.round((flowLpm * 1000) / supplyCm3PerRev);
}

/**
 * Мокрая толщина из целевой сухой плотности и содержания СВ (по объёму):
 * h_wet = σ_сух / (ρ_пасты · φ_об) ; σ в мг/см², ρ в г/см³, φ долями.
 * Результат в мкм: [мг/см² ÷ (г/см³)] = [1e-3 г/см² ÷ г/см³] = 1e-3 см = 10 мкм... уточняем:
 * h[см] = σ[г/см²] / (ρ[г/см³]·φ); σ[мг/см²]=σ·1e-3 г/см²; h[мкм]=h[см]·1e4.
 */
export function wetThicknessUm(targetDryMgm2: number, pasteDensity: number, solidsPctVol: number): number | null {
  if (!targetDryMgm2 || !pasteDensity || !solidsPctVol) return null;
  const sigmaGcm2 = targetDryMgm2 * 1e-3;
  const phi = solidsPctVol / 100;
  const hUm = (sigmaGcm2 / (pasteDensity * phi)) * 1e4;
  return Math.round(hUm * 10) / 10;
}

/**
 * Полезная длина стороны A: сумма участков минус промежутки (для режима с промежутками).
 * На каждом участке длиной L размещается n = floor(L·1000 / pitch) полос,
 * каждая короче на gapWidth. Возвращает длину покрытия и длину пропусков.
 */
export function intermittentCoverage(segLengthsM: number[], gapWidthMm?: number, gapPitchMm?: number) {
  const total = segLengthsM.reduce((s, x) => s + (Number(x) || 0), 0);
  if (!gapWidthMm || !gapPitchMm || gapPitchMm <= 0) {
    return { totalM: total, coatedM: total, skipM: 0 };
  }
  let coated = 0;
  for (const L of segLengthsM) {
    const lenMm = (Number(L) || 0) * 1000;
    const n = Math.floor(lenMm / gapPitchMm);
    const rem = lenMm - n * gapPitchMm;
    coated += n * Math.max(gapPitchMm - gapWidthMm, 0) + Math.max(rem - gapWidthMm, 0);
  }
  const coatedM = coated / 1000;
  return { totalM: total, coatedM: Math.round(coatedM * 100) / 100, skipM: Math.round((total - coatedM) * 100) / 100 };
}

/** Скорость сушки: ориентировочное «время в печи» по длине зоны и скорости ленты (сек). */
export function ovenDwellSeconds(ovenLengthM: number, webSpeedMpm: number): number | null {
  if (!ovenLengthM || !webSpeedMpm) return null;
  return Math.round((ovenLengthM / (webSpeedMpm / 60)) * 10) / 10;
}
