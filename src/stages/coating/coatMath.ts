// Расчётная математика нанесения покрытия: все входы явные, без демо-калибровок.
// Единицы указаны в сигнатурах и проверяются тестами.

const positive=(x:number):boolean=>Number.isFinite(x)&&x>0;
const finiteResult=(x:number):number|null=>positive(x)?x:null;
const tenth=(x:number)=>Math.round(x*10)/10;

/** Эквивалентная мокрая толщина по поданному объёму, НЕ механический зазор головки.
 * Q[cm3/min] / (w[cm] * v[cm/min]) = h[cm]; 1 cm = 10000 um. */
export function headGapUm(qCm3PerMin:number,widthCm:number,webSpeedMpm:number):number|null{
  if(![qCm3PerMin,widthCm,webSpeedMpm].every(positive))return null;
  return finiteResult(tenth(qCm3PerMin/(widthCm*webSpeedMpm*100)*10000));
}

/** Required volumetric flow for one coated face (L/min). */
export function requiredScrewFlowLpm(widthCm:number,wetThicknessUm:number,webSpeedMpm:number):number|null{
  if(![widthCm,wetThicknessUm,webSpeedMpm].every(positive))return null;
  const cm3PerMin=widthCm*wetThicknessUm*1e-4*webSpeedMpm*100;
  return finiteResult(cm3PerMin/1000);
}

/** Estimate RPM only with the actual calibrated delivery in cm3/revolution.
 * A missing calibration MUST NOT be replaced by a sample value. */
export function screwRpmFromFlow(flowLpm:number|null,supplyCm3PerRev?:number):number|null{
  if(flowLpm===null||supplyCm3PerRev===undefined||
    !positive(flowLpm)||!positive(supplyCm3PerRev))return null;
  return finiteResult(Math.round(flowLpm*1000/supplyCm3PerRev));
}

/** Wet-film thickness from dry areal loading [mg/cm2], wet slurry density
 * [g/cm3], and dry-solids MASS percent of the wet slurry.
 * h[um] = dryLoading[mg/cm2] * 10 / (density * massFraction).
 * rho_paste * solids VOL fraction is NOT dry mass per slurry volume.
 * This is a mass-balance estimate, not a verified equipment setting. */
export function wetThicknessUm(dryLoadingMgCm2:number,pasteDensity:number,solidsPctMass:number):number|null{
  if(![dryLoadingMgCm2,pasteDensity,solidsPctMass].every(positive)||solidsPctMass>100)
    return null;
  return finiteResult(tenth(10*dryLoadingMgCm2/(pasteDensity*solidsPctMass/100)));
}

/** Equivalent coated length of one side; does not change physical roll length. */
export function intermittentCoverage(segLengthsM:number[],gapWidthMm?:number,gapPitchMm?:number){
  if(!segLengthsM.length||!segLengthsM.every(positive))return null;
  const total=segLengthsM.reduce((sum,length)=>sum+length,0);
  if(!Number.isFinite(total))return null;
  if(gapWidthMm===undefined&&gapPitchMm===undefined)return {totalM:total,coatedM:total,skipM:0};
  if(gapWidthMm===undefined||gapPitchMm===undefined||!positive(gapWidthMm)||
    !positive(gapPitchMm)||gapWidthMm>=gapPitchMm)return null;
  let coated=0;
  for(const length of segLengthsM){
    const lenMm=length*1000;
    if(!Number.isFinite(lenMm))return null;
    const n=Math.floor(lenMm/gapPitchMm);
    const rem=lenMm-n*gapPitchMm;
    coated+=n*(gapPitchMm-gapWidthMm)+Math.max(rem-gapWidthMm,0);
  }
  const coatedM=coated/1000;
  return Number.isFinite(coatedM)?{totalM:total,coatedM,skipM:total-coatedM}:null;
}

/** Residence time from known oven length and transport speed. */
export function ovenDwellSeconds(ovenLengthM:number,webSpeedMpm:number):number|null{
  if(![ovenLengthM,webSpeedMpm].every(positive))return null;
  return finiteResult(tenth(ovenLengthM/(webSpeedMpm/60)));
}
