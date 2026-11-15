import {db} from '../db';
import {StageId,UserRole,type FormationRun,type User} from '../types';
import {assemblyOutputTables,CELL_OUTPUT_ROLES} from './assemblyCellOutput';
import {validateFormationResult,hasFormationResult,assertSavedFormationSource} from './formationResults';

export interface ProcessedSerialRange {start:number;end:number}
export interface FormationSerialIdentity {
 version:1;id:string;runId:string;assemblyOutputId:string;source:FormationRun;
 ranges:ProcessedSerialRange[];count:number;evidence:string;
 recordedBy:string;recordedRole:UserRole;recordedAt:string;
}
const same=(a:unknown,b:unknown)=>JSON.stringify(a)===JSON.stringify(b);
const text=(v:unknown,max=200):v is string=>typeof v==='string'&&v===v.trim()&&v.length>0&&v.length<=max;
function assemblyOutputId(source:FormationRun){const input=source.inputSnapshot;return (input?.sourceFill??input?.sourceWalz?.inputSnapshot?.sourceFill)?.sourceReceipt?.sourceAssembly?.cellOutput?.id;}
function mayDeclare(source:FormationRun,id:string,role:UserRole){return CELL_OUTPUT_ROLES.includes(role)||id===source.workerId&&role===source.recordedRole;}
/** No expansion, automatic prefix, inferred consecutive subset or count conversion. */
export function parseProcessedSerialRanges(raw:string):ProcessedSerialRange[]{
 if(typeof raw!=='string'||!raw.trim()||raw.length>40000)throw Error('Введите номера явно: 10-11; 13, по возрастанию');
 const parts=raw.trim().split(/[,;\n]/);
 if(parts.length>1000)throw Error('Не более 1000 явно указанных диапазонов');
 return parts.map(part=>{const match=/^(\d+)(?:\s*-\s*(\d+))?$/.exec(part.trim());if(!match)throw Error('Введите целые номера или диапазоны: 10-11; 13');
  const start=Number(match[1]),end=Number(match[2]??match[1]);if(!Number.isSafeInteger(start)||!Number.isSafeInteger(end)||end<start)throw Error('Диапазон номеров должен быть целым и по возрастанию');return{start,end};});
}
export function validateFormationSerialIdentity(value:unknown):asserts value is FormationSerialIdentity {
 const row=value as FormationSerialIdentity;
 if(!row||row.version!==1||!text(row.id)||!text(row.runId)||!text(row.assemblyOutputId)||!text(row.recordedBy)||!Object.values(UserRole).includes(row.recordedRole)||!text(row.evidence,1000)||
  typeof row.recordedAt!=='string'||!Number.isFinite(Date.parse(row.recordedAt))||new Date(row.recordedAt).toISOString()!==row.recordedAt||
  Object.keys(row).some(k=>!['version','id','runId','assemblyOutputId','source','ranges','count','evidence','recordedBy','recordedRole','recordedAt'].includes(k)))throw Error('Повреждено заявление номеров обработанных ячеек');
 validateFormationResult(row.source);
 const input=row.source.serialRange;
 if(!hasFormationResult(row.source)||!input||row.runId!==row.source.id||row.assemblyOutputId!==assemblyOutputId(row.source)||!mayDeclare(row.source,row.recordedBy,row.recordedRole)||Date.parse(row.recordedAt)<Date.parse(row.source.createdAt)||
  !Number.isSafeInteger(row.count)||row.count<=0||row.count!==row.source.cellsOut||!Array.isArray(row.ranges)||!row.ranges.length||row.ranges.length>1000)throw Error('Нужен сохранённый связанный источник и явные номера всей обработанной части; QA не подтверждено');
 let total=0,previous=-1;
 for(const range of row.ranges){
  if(!range||Object.keys(range).some(k=>k!=='start'&&k!=='end')||!Number.isSafeInteger(range.start)||!Number.isSafeInteger(range.end)||range.start<input.start||range.end>input.end||range.end<range.start||range.start<=previous)throw Error('Номера должны быть внутри исходного диапазона, по возрастанию и без пересечений');
  total+=range.end-range.start+1;if(!Number.isSafeInteger(total))throw Error('Количество номеров слишком велико');previous=range.end;
 }
 if(total!==row.count)throw Error('Число явно указанных номеров должно совпадать со всем обработанным количеством');
}
async function insert(row:FormationSerialIdentity){
 validateFormationSerialIdentity(row);
 const old=await db.formationSerialIdentities.get(row.runId);
 if(old){if(same(old,row))return old;throw Error('Номера уже заявлены; исходный источник и заявление не заменены');}
 await assertSavedFormationSource(row.source);
 await db.formationSerialIdentities.add(row);
 await db.journal.add({id:row.id,stage:StageId.FORMATION,workerId:row.recordedBy,createdAt:new Date(row.recordedAt),summary:`Явные номера обработанных ячеек: ${row.source.batchName}; QA не подтверждено`,params:{'Источник формирования':row.runId,'Заявление сборки':row.assemblyOutputId,'Обработано':row.count,'Явные диапазоны':JSON.stringify(row.ranges),'Префикс исходного диапазона':row.source.serialRange!.prefix??'','Основание':row.evidence,'QA':'не подтверждено','Складская приёмка':'не записана'}});
 return row;
}
export function createFormationSerialIdentity(source:FormationRun,ranges:ProcessedSerialRange[],evidence:string,actor:Pick<User,'id'|'role'>,id:string,recordedAt:string):FormationSerialIdentity {
 const row=structuredClone({version:1 as const,id,runId:source.id,assemblyOutputId:assemblyOutputId(source)!,source,ranges,count:source.cellsOut,evidence:evidence.trim(),recordedBy:actor.id,recordedRole:actor.role,recordedAt});
 validateFormationSerialIdentity(row);return row;
}
export function declareFormationSerialIdentity(row:FormationSerialIdentity,actorId:string){
 const original=structuredClone(row);
 return db.transaction('rw',[...assemblyOutputTables(),db.formationSerialIdentities],async()=>{
  const actor=await db.users.get(actorId);
  if(!actor?.isActive||actorId!==original.recordedBy||actor.role!==original.recordedRole||!mayDeclare(original.source,actorId,actor.role))throw Error('Нужен исходный активный автор заявления с неизменной ролью');
  return insert(original);
 });
}
/** Group-key packets preserve declared attribution, not authenticated account,
 * server entitlement, final QC or warehouse acceptance. */
export function receiveFormationSerialIdentity(value:unknown,role?:UserRole,senderId?:string){
 return db.transaction('rw',[...assemblyOutputTables(),db.formationSerialIdentities],async()=>{
  validateFormationSerialIdentity(value);
  if(role!==value.recordedRole||senderId!==value.recordedBy)throw Error('Атрибуция пакета не совпадает с исходным заявлением номеров');
  return insert(structuredClone(value));
 });
}
