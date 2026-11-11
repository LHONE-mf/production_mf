import { db } from '../../core/db';
import { StageId, type CoatRun, type CoatingMixSnapshot } from '../../core/types';
import { intermittentCoverage, requiredScrewFlowLpm, screwRpmFromFlow, wetThicknessUm } from './coatMath';

export interface CoatingEntry {
  foilType:string;
  mixSnapshot?:CoatingMixSnapshot;
  targetDryMgm2?:number;
  coatingWidthCm?:number;
  webSpeedMpm?:number;
  pumpDeliveryCm3Rev?:number;
  headGapUm?:number;
  mode:CoatRun['mode'];
  gapWidthMm?:number;
  gapPitchMm?:number;
  segLengthsM:number[];
  sideBLengthM?:number;
  ovenTempsC:number[];
  defects?:string;
  notes?:string;
}
function positive(value:number|undefined,label:string):asserts value is number {
  if(value===undefined||!Number.isFinite(value)||value<=0)throw new Error(label+': введите число больше нуля');
}

/** Calculations retain their entered inputs. They are estimates, not equipment commands. */
export function prepareCoatingRun(input:CoatingEntry,workerId:string,id:string,now=Date.now()):CoatRun {
  if(!workerId||!input.foilType.trim())throw new Error('Укажите исполнителя и фольгу');
  positive(input.targetDryMgm2,'Сухая поверхностная плотность');
  positive(input.coatingWidthCm,'Ширина полосы');
  positive(input.webSpeedMpm,'Скорость фольги');
  if(input.pumpDeliveryCm3Rev!==undefined)positive(input.pumpDeliveryCm3Rev,'Калиброванная подача насоса');
  if(input.headGapUm!==undefined)positive(input.headGapUm,'Заданный зазор головки');
  if(input.sideBLengthM!==undefined&&(!Number.isFinite(input.sideBLengthM)||input.sideBLengthM<0))
    throw new Error('Длина стороны B: введите неотрицательное число');
  if(input.ovenTempsC.length!==0&&(input.ovenTempsC.length!==6||
    input.ovenTempsC.some(t=>!Number.isFinite(t)||t<0)))
    throw new Error('Печи: оставьте все зоны пустыми или укажите 6 неотрицательных температур');
  const mix=input.mixSnapshot;
  if(mix?.pasteDensity!==undefined)positive(mix.pasteDensity,'Плотность пасты');
  if(mix?.solidsPctMass!==undefined){
    positive(mix.solidsPctMass,'Массовая доля СВ');
    if(mix.solidsPctMass>100)throw new Error('Массовая доля СВ не может превышать 100%');
  }
  const coverage=intermittentCoverage(input.segLengthsM,
    input.mode==='intermittent'?input.gapWidthMm:undefined,
    input.mode==='intermittent'?input.gapPitchMm:undefined);
  if(!coverage||input.mode==='intermittent'&&(input.gapWidthMm===undefined||input.gapPitchMm===undefined))
    throw new Error('Укажите положительные длины; промежуток должен быть больше нуля и меньше шага');
  const wet=mix?.pasteDensity!==undefined&&mix.solidsPctMass!==undefined
    ?wetThicknessUm(input.targetDryMgm2,mix.pasteDensity,mix.solidsPctMass):null;
  const flow=wet===null?null:requiredScrewFlowLpm(input.coatingWidthCm,wet,input.webSpeedMpm);
  return {...input,id,workerId,foilType:input.foilType.trim(),mixBatchId:mix?.mixBatchId,
    mixSnapshot:mix?{...mix}:undefined,segLengthsM:[...input.segLengthsM],ovenTempsC:[...input.ovenTempsC],
    sideALengthM:coverage.coatedM,wetThicknessUm:wet??undefined,estimatedFlowLpm:flow??undefined,
    screwRpm:screwRpmFromFlow(flow,input.pumpDeliveryCm3Rev)??undefined,
    defects:input.defects?.trim()||undefined,notes:input.notes?.trim()||undefined,
    gapWidthMm:input.mode==='intermittent'?input.gapWidthMm:undefined,
    gapPitchMm:input.mode==='intermittent'?input.gapPitchMm:undefined,createdAt:now,updatedAt:now};
}

/** One local operation: failure of either store rolls both writes back. */
export async function saveCoatingRun(input:CoatingEntry,workerId:string,id:string):Promise<CoatRun> {
  const run=prepareCoatingRun(input,workerId,id);
  await db.transaction('rw',db.coatRuns,db.journal,async()=>{
    await db.coatRuns.add(run);
    await db.journal.add({id:run.id,stage:StageId.COATING,workerId,
      summary:`Нанесение: ${run.mixSnapshot?.recipeName??'без замеса'}, сторона A ${run.sideALengthM} м`,
      params:{'Запись нанесения':run.id,'Ширина, см':run.coatingWidthCm!,
        'Лента, м/мин':run.webSpeedMpm!,'Мокрая толщина (оценка), мкм':run.wetThicknessUm??'',
        'Шнек (оценка), об/мин':run.screwRpm??'','Заданный зазор, мкм':run.headGapUm??'',
        'Печи, °C':run.ovenTempsC.length?run.ovenTempsC.join('/'):'не указаны'},
      defects:run.defects??'',createdAt:new Date(run.createdAt)});
  });
  return run;
}
