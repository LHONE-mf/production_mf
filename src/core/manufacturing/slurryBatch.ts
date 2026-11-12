import {db} from '../db';
import {StageId,UserRole,type MixBatch,type CoatingMixSnapshot} from '../types';
import {CELL_OUTPUT_ROLES} from './assemblyCellOutput';
import {SLURRY_BASIS,calculateSlurryPlan,slurryMassBalance} from './slurryMath';

export const SLURRY_UNITS={mass:'g',targetDry:'kg',solids:'mass-fraction',density:'g/cm3',viscosity:'mPa.s',fineness:'um'} as const;
const same=(a:unknown,b:unknown)=>JSON.stringify(a)===JSON.stringify(b);
const text=(v:unknown)=>typeof v==='string'&&!!v.trim();
const time=(v:unknown)=>typeof v==='number'&&Number.isFinite(v)&&v>0&&Number.isFinite(new Date(v).getTime());
const code=(v:string)=>v.trim().toLocaleLowerCase('ru-RU');
const tables=()=>[db.mixBatches,db.mixRecipes,db.mixComponents,db.journal,db.users,db.coatIncomingMixes,db.coatRuns];
export const hasMeasuredSlurryBatch=(batch?:MixBatch)=>!!batch&&(batch.measurementVersion!==undefined||batch.batchCode!==undefined||batch.recipePlan!==undefined||batch.componentSnapshots!==undefined||batch.massBalance!==undefined||batch.recipeSnapshot!==undefined||batch.measurementUnits!==undefined);
export const hasSlurryHandover=(snap?:CoatingMixSnapshot)=>!!snap&&(snap.handoverVersion!==undefined||snap.sourceBatch!==undefined||snap.solidsBasis!==undefined||snap.densityBasis!==undefined);

export class SlurryFieldError extends Error {
 constructor(readonly field:'batchCode'|'recipeName'|'measurementNote',message:string){super(message);}
}
export function validateMeasuredSlurryBatch(batch:MixBatch):void {
 if(!batch||batch.measurementVersion!==1||!text(batch.id)||!text(batch.workerId)||!Object.values(UserRole).includes(batch.recordedRole!)||!time(batch.createdAt)||batch.updatedAt!==batch.createdAt||!batch.recipePlan||!Array.isArray(batch.componentSnapshots)||!Array.isArray(batch.weighings))throw new Error('Некорректные служебные данные замеса: ID, автор/роль, время, план или версии материалов.');
 for(const [field,label] of [['batchCode','Код партии замеса'],['recipeName','Название состава'],['measurementNote','Основание навесок и состава']] as const){
  if(!text(batch[field]))throw new SlurryFieldError(field,`Заполните поле «${label}». Остальные введённые значения не нужно вводить заново.`);
 }
 if(batch.measurementNote!.length>2000)throw new SlurryFieldError('measurementNote','Поле «Основание навесок и состава»: не более 2000 символов; можно указать ссылку на исходную запись или документ.');
 if(!batch.measurementUnits||Object.entries(SLURRY_UNITS).some(([key,unit])=>batch.measurementUnits![key as keyof typeof SLURRY_UNITS]!==unit))throw new Error('Единицы замеса: план СВ кг, навески г, состав массовый; измерения мПа·с, мкм, г/см³');
 if(batch.modeActual!==undefined||batch.pasteCalc!==undefined)throw new Error('Плановый режим и модельные свойства нельзя записать как измеренные данные замеса');
 const source=batch.recipeSnapshot;
 if(source?source.id!==batch.recipeId||source.name!==batch.recipeName||!time(source.updatedAt)||source.basis!==undefined&&source.basis!==batch.recipePlan.basis||!same(source.lines,batch.recipePlan.lines):batch.recipeId!==undefined)throw new Error('Версия, база и строки исходного рецепта должны сохраняться без подмены');
 const plan=calculateSlurryPlan(batch.recipePlan.lines,batch.componentSnapshots,batch.batchKg,batch.recipePlan.basis);
 if(new Set(batch.componentSnapshots.map(c=>c.id)).size!==batch.componentSnapshots.length||batch.componentSnapshots.length!==plan.rows.length||batch.weighings.length!==plan.rows.length||batch.weighings.some((row,i)=>!row||row.componentId!==plan.rows[i].componentId||row.plannedG!==plan.rows[i].grams||typeof row.actualG!=='number'))throw new Error('План и фактические массы должны однозначно сохранять все материалы, порядок и единицы');
 const balance=slurryMassBalance(batch.weighings,batch.componentSnapshots);
 if(balance.missingCount||!balance.totalActualG||balance.solidsPctMass===undefined||!same(batch.massBalance,balance))throw new Error('Все навески вводятся явно; сумма фактически записанных масс положительна, расчёт состава не заменяется планом');
 for(const [key,min,inclusive] of [['viscosity',0,false],['fineness',0,true],['measuredDensity',0,false]] as const){const value=batch[key];if(value!==undefined&&(typeof value!=='number'||!Number.isFinite(value)||value<min||!inclusive&&value===min))throw new Error('Введённые измерения должны быть конечными: вязкость и плотность положительны, перетир неотрицателен');}
}
function sender(role:UserRole|undefined,senderId:string|undefined,actorId:string,actorRole:UserRole|undefined){
 if(!role||!CELL_OUTPUT_ROLES.includes(role)&&(senderId!==actorId||role!==actorRole))throw new Error('Подписант не совпадает с автором наблюдения');
}
async function insertBatch(batch:MixBatch,local:boolean):Promise<MixBatch>{
 const old=await db.mixBatches.get(batch.id);if(old){if(same(old,batch))return old;throw new Error('ID замеса уже сохранён; исходные навески и версии не заменяются');}
 const rows=await db.mixBatches.toArray();
 if(hasMeasuredSlurryBatch(batch)){
  validateMeasuredSlurryBatch(batch);
  if(rows.some(row=>hasMeasuredSlurryBatch(row)?code(row.batchCode!)===code(batch.batchCode!):code(row.recipeName)===code(batch.batchCode!)))throw new Error('Код партии уже записан или старая история неоднозначна');
  if(local){
   for(const component of batch.componentSnapshots!)if(!same(await db.mixComponents.get(component.id),component))throw new Error('Материал изменён или отсутствует; обновите версии явно и проверьте навески');
   if(batch.recipeSnapshot&&!same(await db.mixRecipes.get(batch.recipeId!),batch.recipeSnapshot))throw new Error('Рецепт изменён или отсутствует; выберите версию заново');
  }else{
   for(const component of batch.componentSnapshots!){const known=await db.mixComponents.get(component.id);if(known?.updatedAt===component.updatedAt&&!same(known,component))throw new Error('Содержимое известной версии материала изменено');}
   if(batch.recipeSnapshot){const known=await db.mixRecipes.get(batch.recipeId!);if(known?.updatedAt===batch.recipeSnapshot.updatedAt&&!same(known,batch.recipeSnapshot))throw new Error('Содержимое известной версии рецепта изменено');}
  }
 }else{
  if(!batch||!text(batch.id)||!text(batch.recipeName)||!Array.isArray(batch.weighings))throw new Error('Исторический замес повреждён');
  if(rows.some(row=>hasMeasuredSlurryBatch(row)&&(row.recipeName===batch.recipeName||row.batchCode===batch.recipeName)))throw new Error('Старый пакет не может обойти защищённую запись замеса');
 }
 await db.mixBatches.add(batch);
 if(hasMeasuredSlurryBatch(batch))await db.journal.add({id:batch.id,stage:StageId.SLURRY,workerId:batch.workerId,createdAt:new Date(batch.createdAt),taskId:batch.taskId,summary:`Записанные навески: ${batch.batchCode}; QA не подтверждено`,params:{'Снимок замеса':JSON.stringify(batch),'Фактическая масса, г':batch.massBalance!.totalActualG!,'Расчёт СВ по навескам, г':batch.massBalance!.solidsActualG!},defects:batch.notes});
 return batch;
}
export async function saveSlurryBatch(batch:MixBatch,actorId:string):Promise<MixBatch>{
 return db.transaction('rw',tables(),async()=>{
  const actor=await db.users.get(actorId);if(!actor?.isActive||actor.id!==batch.workerId||actor.role!==batch.recordedRole)throw new Error('Нужен активный локальный профиль автора навесок');
  validateMeasuredSlurryBatch(batch);return insertBatch(batch,true);
 });
}
export async function receiveSlurryBatch(batch:MixBatch,stage?:StageId,role?:UserRole,senderId?:string):Promise<MixBatch>{
 return db.transaction('rw',tables(),async()=>{if(stage!==StageId.SLURRY)throw new Error('Неверный этап замеса');if(hasMeasuredSlurryBatch(batch)){validateMeasuredSlurryBatch(batch);sender(role,senderId,batch.workerId,batch.recordedRole);}return insertBatch(batch,false);});
}
export function validateSlurryHandover(snap:CoatingMixSnapshot):void {
 const batch=snap?.sourceBatch;if(snap?.handoverVersion!==1||!batch)throw new Error('Передача требует сохранённого замеса с измеренными навесками');validateMeasuredSlurryBatch(batch);
 if(snap.mixBatchId!==batch.id||snap.recipeName!==batch.recipeName||snap.viscosity!==batch.viscosity||snap.fineness!==batch.fineness||snap.solidsPctMass!==batch.massBalance!.solidsPctMass||snap.solidsPctVol!==undefined||snap.pasteDensity!==batch.measuredDensity||snap.batchKg!==batch.massBalance!.solidsActualG!/1000||snap.solidsBasis!=='weighed-masses-and-declared-composition'||snap.densityBasis!==(batch.measuredDensity===undefined?'unknown':'measured')||!text(snap.preparedBy)||!Object.values(UserRole).includes(snap.preparedRole!)||!time(snap.createdAt)||snap.preparedRole===UserRole.WORKER&&snap.preparedBy!==batch.workerId)throw new Error('Передача должна сохранять источник и фактический состав; расчётная плотность/вязкость не заменяют измерение');
}
async function insertHandover(snap:CoatingMixSnapshot):Promise<CoatingMixSnapshot>{
 const old=await db.coatIncomingMixes.get(snap.mixBatchId);if(old){if(same(old,snap))return old;throw new Error('Передача на намазку уже сохранена; исходный снимок не заменяется');}
 if(hasSlurryHandover(snap)){
  validateSlurryHandover(snap);await insertBatch(snap.sourceBatch!,false);
 }else{
  if(!snap||!text(snap.mixBatchId)||!text(snap.recipeName))throw new Error('Историческая передача повреждена');
  const batches=await db.mixBatches.toArray();if(batches.some(batch=>hasMeasuredSlurryBatch(batch)&&(batch.id===snap.mixBatchId||batch.recipeName===snap.recipeName)))throw new Error('Старый пакет не может обойти источник измеренного замеса');
 }
 await db.coatIncomingMixes.add(snap);return snap;
}
export async function prepareSlurryHandover(expected:MixBatch,actorId:string):Promise<CoatingMixSnapshot>{
 return db.transaction('rw',tables(),async()=>{
  const actor=await db.users.get(actorId);if(!actor?.isActive||!CELL_OUTPUT_ROLES.includes(actor.role)&&actor.id!==expected.workerId)throw new Error('Нужен активный автор замеса или локальный руководитель');
  const batch=await db.mixBatches.get(expected.id);if(!batch||!same(batch,expected))throw new Error('Замес отсутствует или изменён');validateMeasuredSlurryBatch(batch);
  const old=await db.coatIncomingMixes.get(batch.id);if(old){if(same(old.sourceBatch,batch)){validateSlurryHandover(old);return old;}throw new Error('Передача уже имеет другой исходный снимок');}
  const snap:CoatingMixSnapshot={handoverVersion:1,sourceBatch:batch,mixBatchId:batch.id,recipeName:batch.recipeName,viscosity:batch.viscosity,fineness:batch.fineness,solidsPctMass:batch.massBalance!.solidsPctMass,pasteDensity:batch.measuredDensity,batchKg:batch.massBalance!.solidsActualG!/1000,solidsBasis:'weighed-masses-and-declared-composition',densityBasis:batch.measuredDensity===undefined?'unknown':'measured',preparedBy:actor.id,preparedRole:actor.role,createdAt:Date.now()};
  await insertHandover(snap);await db.journal.add({id:`slurry-handover:${batch.id}`,stage:StageId.SLURRY,workerId:actor.id,createdAt:new Date(snap.createdAt),summary:`Записана передача данных замеса: ${batch.batchCode}`,params:{'Источник':batch.id,'Снимок передачи':JSON.stringify(snap),'Физическое получение':'не подтверждено'}});return snap;
 });
}
export async function receiveSlurryHandover(snap:CoatingMixSnapshot,stage?:StageId,role?:UserRole,senderId?:string):Promise<CoatingMixSnapshot>{
 return db.transaction('rw',tables(),async()=>{if(stage!==StageId.COATING)throw new Error('Неверный этап назначения замеса');if(hasSlurryHandover(snap)){validateSlurryHandover(snap);sender(role,senderId,snap.preparedBy!,snap.preparedRole);}return insertHandover(snap);});
}
