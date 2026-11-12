import { db } from '../../core/db';
import { StageId, UserRole, type MixBatch, type CoatRun, type CoatingMixSnapshot, type RollSpec } from '../../core/types';
import {hasMeasuredSlurryBatch,hasSlurryHandover,validateSlurryHandover} from '../../core/manufacturing/slurryBatch';
import { intermittentCoverage, requiredScrewFlowLpm, screwRpmFromFlow, wetThicknessUm } from './coatMath';

export interface CoatingEntry {
  foilType:string;
  mixSnapshot?:CoatingMixSnapshot;
  targetDryMgm2?:number;
  coatingWidthCm?:number;
  webSpeedMpm?:number;
  pumpDeliveryCm3Rev?:number;
  headGapUm?:number;
  measuredDryThicknessUm?:number;
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
  if(!['continuous','intermittent'].includes(input.mode))throw Error('Выберите режим нанесения явно');
  if(!workerId||!input.foilType.trim())throw new Error('Укажите исполнителя и фольгу');
  positive(input.targetDryMgm2,'Сухая поверхностная плотность');
  positive(input.coatingWidthCm,'Ширина полосы');
  positive(input.webSpeedMpm,'Скорость фольги');
  if(input.pumpDeliveryCm3Rev!==undefined)positive(input.pumpDeliveryCm3Rev,'Калиброванная подача насоса');
  if(input.headGapUm!==undefined)positive(input.headGapUm,'Заданный зазор головки');
  if(input.measuredDryThicknessUm!==undefined)positive(input.measuredDryThicknessUm,'Измеренная толщина сухого электрода');
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

const same=(a:unknown,b:unknown)=>JSON.stringify(a)===JSON.stringify(b);
export const hasRecordedCoatingRun=(run?:CoatRun)=>!!run&&(run.recordingVersion!==undefined||run.recordedRole!==undefined);
export function coatingSourceFromBatch(batch:MixBatch):CoatingMixSnapshot|undefined {
 if(hasMeasuredSlurryBatch(batch))return;
 return {mixBatchId:batch.id,recipeName:batch.recipeName,viscosity:batch.viscosity,fineness:batch.fineness,solidsPctMass:batch.pasteCalc?.solidsPctMass,solidsPctVol:batch.pasteCalc?.solidsPctVol,pasteDensity:batch.pasteCalc?.pasteDensity,batchKg:batch.batchKg,createdAt:batch.createdAt};
}
export function coatingEntryFromRun(run:CoatRun):CoatingEntry {
 const {foilType,mixSnapshot,targetDryMgm2,coatingWidthCm,webSpeedMpm,pumpDeliveryCm3Rev,headGapUm,measuredDryThicknessUm,mode,gapWidthMm,gapPitchMm,segLengthsM,sideBLengthM,ovenTempsC,defects,notes}=run;
 return {foilType,mixSnapshot,targetDryMgm2,coatingWidthCm,webSpeedMpm,pumpDeliveryCm3Rev,headGapUm,measuredDryThicknessUm,mode,gapWidthMm,gapPitchMm,segLengthsM,sideBLengthM,ovenTempsC,defects,notes};
}
export function prepareRecordedCoatingRun(input:CoatingEntry,workerId:string,id:string,role:UserRole,now=Date.now()):CoatRun {
 if(!id?.trim()||!Object.values(UserRole).includes(role)||!Number.isFinite(now)||now<=0||!Number.isFinite(new Date(now).getTime()))throw Error('Нужны ID, роль и время записи нанесения');
 const mix=input.mixSnapshot;
 if(mix&&(!mix.mixBatchId?.trim()||!mix.recipeName?.trim()||!Number.isFinite(mix.createdAt)||mix.createdAt<=0))throw Error('Исходный замес требует ID, название и версию');
 if(mix&&hasSlurryHandover(mix))validateSlurryHandover(mix);
 return {...prepareCoatingRun(input,workerId,id,now),recordingVersion:1,recordedRole:role};
}
export function validateRecordedCoatingRun(run:CoatRun):void {
 if(run?.recordingVersion!==1)throw Error('Версия записи нанесения не поддерживается');
 const expected=prepareRecordedCoatingRun(coatingEntryFromRun(run),run.workerId,run.id,run.recordedRole!,run.createdAt);
 if([...new Set([...Object.keys(expected),...Object.keys(run)])].some(key=>!same(run[key as keyof CoatRun],expected[key as keyof CoatRun])))throw Error('Снимок нанесения, единицы, время и расчётные оценки должны сохраняться без подмены');
}
async function knownSource(id:string){const incoming=await db.coatIncomingMixes.get(id);if(incoming)return incoming;const batch=await db.mixBatches.get(id);return batch?coatingSourceFromBatch(batch):undefined;}
async function insertRecordedCoatingRun(run:CoatRun,local:boolean):Promise<CoatRun>{
 validateRecordedCoatingRun(run);
 const existing=await db.coatRuns.get(run.id);if(existing){if(same(existing,run))return existing;throw Error('ID нанесения уже сохранён с другим содержимым; история не заменяется');}
 if(run.mixSnapshot){const current=await knownSource(run.mixSnapshot.mixBatchId);if(local?!same(current,run.mixSnapshot):current&&(hasSlurryHandover(current)||current.createdAt===run.mixSnapshot.createdAt)&&!same(current,run.mixSnapshot))throw Error('Источник замеса изменён или отсутствует. Обновите источник явно и проверьте введённые значения');}
 const workerId=run.workerId;
 await db.coatRuns.add(run);
    await db.journal.add({id:run.id,stage:StageId.COATING,workerId,
      summary:`Нанесение: ${run.mixSnapshot?.recipeName??'без замеса'}, сторона A ${run.sideALengthM} м`,
      params:{'Запись нанесения':run.id,'Ширина, см':run.coatingWidthCm!,
        'Лента, м/мин':run.webSpeedMpm!,'Мокрая толщина (оценка), мкм':run.wetThicknessUm??'',
        'Измеренная сухая толщина с фольгой, мкм':run.measuredDryThicknessUm??'',
        'Шнек (оценка), об/мин':run.screwRpm??'','Заданный зазор, мкм':run.headGapUm??'',
        'Печи, °C':run.ovenTempsC.length?run.ovenTempsC.join('/'):'не указаны'},
      defects:run.defects??'',createdAt:new Date(run.createdAt)});
 return run;
}
const coatingTables=()=>[db.coatRuns,db.journal,db.users,db.coatIncomingMixes,db.mixBatches];
export async function savePreparedCoatingRun(run:CoatRun,actorId:string):Promise<CoatRun>{
 return db.transaction('rw',coatingTables(),async()=>{
  const actor=await db.users.get(actorId);if(!actor?.isActive||run.workerId!==actor.id||run.recordedRole!==actor.role)throw Error('Нужен активный локальный профиль автора нанесения');
  return insertRecordedCoatingRun(run,true);
 });
}
/** Compatibility for entry callers; restart-safe UI checkpoints the prepared run. */
export async function saveCoatingRun(input:CoatingEntry,workerId:string,id:string):Promise<CoatRun>{
 const actor=await db.users.get(workerId);if(!actor?.isActive)throw Error('Нужен активный локальный профиль автора нанесения');
 const old=await db.coatRuns.get(id);return savePreparedCoatingRun(prepareRecordedCoatingRun(input,workerId,id,actor.role,old?.createdAt),workerId);
}
export async function receiveCoatingRun(run:CoatRun,stage?:StageId,role?:UserRole,senderId?:string,forced=false):Promise<CoatRun>{
 return db.transaction('rw',coatingTables(),async()=>{
  if(stage!==StageId.COATING||!run?.id?.trim())throw Error('Некорректный этап или ID нанесения');
  const previous=await db.coatRuns.get(run.id);
  if(hasRecordedCoatingRun(run)||hasRecordedCoatingRun(previous)){
   validateRecordedCoatingRun(run);
   if(role!==UserRole.MASTER&&role!==UserRole.CHIEF&&(role!==run.recordedRole||senderId!==run.workerId))throw Error('Подписант не совпадает с автором нанесения');
   return insertRecordedCoatingRun(run,false);
  }
  if(previous&&(!forced&&previous.updatedAt>=run.updatedAt||same(previous,run)))return previous;
  await db.coatRuns.put(run);return run;
 });
}

/** Never substitute a wet-film estimate for a dry electrode measurement. */
export function coatingRollSpec(run:CoatRun):RollSpec {
  const measured=run.measuredDryThicknessUm;
  if(measured!==undefined){
    positive(measured,'Измеренная толщина сухого электрода');
    if(typeof run.workerId!=='string'||!run.workerId.trim()||!Number.isFinite(run.createdAt)||run.createdAt<=0||!Number.isFinite(new Date(run.createdAt).getTime()))
      throw new Error('У замера отсутствует исполнитель или время записи');
  }
  return {id:run.id,mixName:run.mixSnapshot?.recipeName??'Без замеса',
    thicknessBeforeUm:measured,
    thicknessBeforeMeasurement:measured===undefined?undefined:{basis:'dry-electrode-including-foil',recordedBy:run.workerId,recordedAt:run.createdAt},
    segLengthsM:[...run.segLengthsM],sideALengthM:run.sideALengthM,sideBLengthM:run.sideBLengthM,
    foilType:run.foilType,createdAt:run.createdAt};
}

/** Stable source identity: retries reuse the snapshot; changed content cannot overwrite it. */
export async function saveCoatingRollHandover(run:CoatRun):Promise<RollSpec> {
  const spec=coatingRollSpec(run);
  return db.transaction('rw',[db.rollSpecs,db.coatRuns],async()=>{
    if(hasRecordedCoatingRun(run)){validateRecordedCoatingRun(run);if(!same(await db.coatRuns.get(run.id),run))throw Error('Источник рулона не сохранён или сохранён с другими данными');}
    const existing=await db.rollSpecs.get(spec.id);
    if(existing){
      const fields=['mixName','foilType','sideALengthM','sideBLengthM','thicknessBeforeUm'] as const;
      const before=existing.thicknessBeforeMeasurement,after=spec.thicknessBeforeMeasurement;
      if(fields.some(key=>existing[key]!==spec[key])||JSON.stringify(existing.segLengthsM)!==JSON.stringify(spec.segLengthsM)||
        before?.basis!==after?.basis||before?.recordedBy!==after?.recordedBy||before?.recordedAt!==after?.recordedAt)
        throw new Error('Рулон с этим ID уже сохранён с другими данными. Исходная передача сохранена; создайте отдельную исправленную запись.');
      return existing;
    }
    await db.rollSpecs.add(spec);
    return spec;
  });
}
