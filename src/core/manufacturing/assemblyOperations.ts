import {validateAssemblyIntake} from './assemblyIntakeValidation';
import {validateAssemblySources,declaredAssemblySources} from './assemblySource';
import {db} from '../db';
import {ASSEMBLY_SUBSTATIONS,StageId,type AssemblyOp,type AssemblyRun} from '../types';
import {validAssemblyCounts} from './assemblyCounts';

const same=(a:unknown,b:unknown)=>JSON.stringify(a)===JSON.stringify(b);
export function hasAssemblyOperationLedger(run?:AssemblyRun):boolean {
 return !!run&&(run.sourceLedger!==undefined||run.operationLedger!==undefined||run.ops?.some(op=>op.id!==undefined||op.recordedAt!==undefined||op.units!==undefined||op.source!==undefined||op.conversionNote!==undefined));
}
export function validateAssemblyOperation(op:AssemblyOp):void {
 const units=['parts','electrodes','sets','blocks','cells'];
 if(!op||typeof op.id!=='string'||!op.id.trim()||typeof op.recordedAt!=='string'||!Number.isFinite(Date.parse(op.recordedAt))||op.finishedAt!==op.recordedAt||
  (op.conversionNote!==undefined&&(typeof op.conversionNote!=='string'||op.conversionNote.length>1000))||
  typeof op.workerId!=='string'||!op.workerId.trim()||!ASSEMBLY_SUBSTATIONS.some(s=>s.id===op.substation)||!validAssemblyCounts(op)||
  !op.units||![op.units.input,op.units.output,op.units.scrap].every(unit=>typeof unit==='string'&&units.includes(unit))||
  (op.substation==='z-stacking'&&op.params?.['Слоёв в стеке']!==undefined&&(!Number.isSafeInteger(op.params['Слоёв в стеке'])||Number(op.params['Слоёв в стеке'])<=0))||
  !op.params||Array.isArray(op.params)||typeof op.params!=='object'||Object.values(op.params).some(v=>typeof v!=='string'&&(typeof v!=='number'||!Number.isFinite(v)))||
  !Array.isArray(op.defects)||op.defects.some(d=>typeof d!=='string')||(op.note!==undefined&&typeof op.note!=='string'))
  throw new Error('Операция не сохранена: проверьте целые количества, единицы, параметры и автора.');
}
// The batch identity and historical totals are immutable during observation append.
function metadata(run:AssemblyRun){const {ops,updatedAt,operationLedger,sourceLedger,...rest}=run;return rest;}
function validateLedger(run:AssemblyRun):void {
 if(typeof run.id!=='string'||!run.id||typeof run.batchName!=='string'||!run.batchName||!Array.isArray(run.defects)||run.defects.some(d=>typeof d!=='string')||run.operationLedger!==1||!Array.isArray(run.ops)||!run.ops.length||typeof run.updatedAt!=='string'||!Number.isFinite(Date.parse(run.updatedAt)))throw new Error('Журнал операций повреждён или приёмка ещё не разрешает станции');
 if(run.sourceLedger!==undefined&&run.sourceLedger!==1)throw new Error('Неизвестная версия связей');
 if(run.intake){
  if(run.sourceLedger!==1)throw new Error('Приёмка требует явного источника каждой операции');
  validateAssemblyIntake({...run,ops:[],updatedAt:run.createdAt,operationLedger:undefined,sourceLedger:undefined});
 }
 const ids=new Set<string>();
 for(const op of run.ops){
  if(!op||!Array.isArray(op.defects)||!op.params||typeof op.params!=='object'||Array.isArray(op.params))throw new Error('История операций повреждена; исходная запись сохранена');
  if(op.id!==undefined||op.recordedAt!==undefined||op.units!==undefined||op.source!==undefined||op.conversionNote!==undefined){
   validateAssemblyOperation(op);if(ids.has(op.id!))throw new Error('Повтор ID операции');ids.add(op.id!);
  }
 }
 if(!ids.size)throw new Error('Отсутствует запись нового журнала операций');
 validateAssemblySources(run);
}
async function assertOperationOwnership(run:AssemblyRun):Promise<void>{
 const ids=new Set(run.ops.filter(op=>op.id).map(op=>op.id));
 const declared=new Set(declaredAssemblySources(run));
 const others=(await db.assemblyRuns.toArray()).filter(other=>other.id!==run.id);
 if(others.some(other=>declaredAssemblySources(other).some(reference=>declared.has(reference))))throw new Error('Внешний источник уже распределён в другой партии');
 if(run.intake&&others.some(other=>other.intake?.sortRunId===run.intake!.sortRunId||!other.intake&&other.batchName===run.batchName))throw new Error('Источник приёмки уже занят или неоднозначен');
 if((await db.assemblyRuns.toArray()).some(other=>other.id!==run.id&&other.ops.some(op=>op.id&&ids.has(op.id))))throw new Error('ID операции уже принадлежит другой партии');
}
export async function appendAssemblyOperation(expected:AssemblyRun,op:AssemblyOp,actorId:string):Promise<AssemblyRun>{
 validateAssemblyOperation(op);
 if(op.workerId!==actorId||!actorId)throw new Error('Автор операции не совпадает с текущим профилем');
 return db.transaction('rw',db.assemblyRuns,db.journal,async()=>{
  const current=await db.assemblyRuns.get(expected.id);
  if(!current)throw new Error('Партия недоступна для станционных наблюдений');
  const previous=current.ops.find(row=>row.id===op.id);
  if(previous){if(same(previous,op))return current;throw new Error('Конфликт ID операции; исходная запись сохранена');}
  if(!op.source)throw new Error('Укажите источник операции');
  if(!same(current,expected))throw new Error('Партия изменена. Проверьте журнал и повторите сохранение.');
  const next:AssemblyRun={...current,operationLedger:1,sourceLedger:1,ops:[...current.ops,op],updatedAt:new Date().toISOString()};
  validateLedger(next);await assertOperationOwnership(next);
  await db.assemblyRuns.put(next);
  await db.journal.add({id:op.id!,stage:StageId.ASSEMBLY,workerId:op.workerId,createdAt:new Date(op.recordedAt!),summary:`Наблюдение сборки: ${current.batchName}`,
   params:{'Партия сборки':current.id,'Станция':op.substation,'Источник':JSON.stringify(op.source),'Вход':op.qtyIn,'Единица входа':op.units!.input!,
    'Выход':op.qtyOut,'Единица выхода':op.units!.output!,'Брак':op.qtyScrap,'Единица брака':op.units!.scrap!,'Выпуск ячеек':'не определён'}});
  return next;
 });
}
export async function receiveAssemblyOperationRun(run:AssemblyRun):Promise<AssemblyRun>{
 return db.transaction('rw',db.assemblyRuns,async()=>{
  validateLedger(run);
  const old=await db.assemblyRuns.get(run.id);
  if(old){
   if(same(old,run))return old;
   if(old.sourceLedger===1&&run.sourceLedger!==1||!same(metadata(old),metadata(run))||old.ops.length>=run.ops.length||!old.ops.every((op,i)=>same(op,run.ops[i])))
    throw new Error('Конфликт истории сборки: исходные операции сохранены');
   if(run.sourceLedger!==1)throw new Error('Новые операции требуют явных источников');
   for(const op of run.ops.slice(old.ops.length)){validateAssemblyOperation(op);if(!op.source)throw new Error('Отсутствует источник новой операции');}
  }
  await assertOperationOwnership(run);await db.assemblyRuns.put(run);return run;
 });
}
