import {db} from '../db';
import {UserRole,type User,type CuttingIncoming} from '../types';

export interface CuttingInstructionInput {
  electrodeType:'strip'|'prismatic';electrodeLengthMm:number;webWidthMm:number;
  electrodeWidthMm?:number;coatingType?:string;techNotes?:string;
}
const positive=(value:unknown):value is number=>typeof value==='number'&&Number.isFinite(value)&&value>0;
export function validateInstructionInput(input:CuttingInstructionInput):void {
  if(!['strip','prismatic'].includes(input.electrodeType)||!positive(input.electrodeLengthMm)||!positive(input.webWidthMm)||
    input.electrodeType==='prismatic'&&(!positive(input.electrodeWidthMm)||input.electrodeWidthMm>input.webWidthMm))
    throw new Error('Выберите тип и укажите положительные размеры в мм. Ширина пластины не должна превышать ширину полотна.');
}
export function validateCuttingIncoming(input:CuttingIncoming):void {
  if(!input||typeof input.id!=='string'||!input.id||!input.roll||typeof input.roll.id!=='string'||
    !['strip','prismatic'].includes(input.electrodeType))throw new Error('Пакет задания нарезки повреждён');
  for(const value of [input.electrodeLengthMm,input.webWidthMm,input.electrodeWidthMm])
    if(value!==undefined&&!positive(value))throw new Error('Недопустимые размеры задания');
  if(input.instruction){
    validateInstructionInput(input as CuttingInstructionInput);
    const source=input.calender,stamp=input.instruction;
    if(!positive(stamp.calenderUpdatedAt)||typeof stamp.recordedBy!=='string'||!stamp.recordedBy.trim()||!positive(stamp.recordedAt)||
      !Number.isFinite(new Date(stamp.recordedAt).getTime())||!source||source.id!==input.id||source.rollId!==input.roll.id||
      source.updatedAt!==stamp.calenderUpdatedAt||!positive(source.totalLengthM)||!positive(source.thicknessAfterUm)||
      source.thicknessAfterUm!==input.thicknessAfterUm||source.hasDefects!==false||typeof source.workerId!=='string'||!source.workerId.trim()||!Array.isArray(source.gapsMm)||
      !source.gapsMm.length||source.gapsMm.some(n=>!positive(n)))throw new Error('Источник или автор задания нарезки не подтверждён');
  }
}
export function sameCuttingInstruction(a:CuttingIncoming,b:CuttingIncoming):boolean {
  return (['electrodeType','electrodeLengthMm','electrodeWidthMm','webWidthMm','coatingType','techNotes'] as const)
    .every(key=>a[key]===b[key])&&!!a.instruction&&!!b.instruction&&
    JSON.stringify(a.roll)===JSON.stringify(b.roll)&&JSON.stringify(a.calender)===JSON.stringify(b.calender)&&a.roll.id===b.roll.id&&a.instruction.calenderUpdatedAt===b.instruction.calenderUpdatedAt&&
    a.instruction.recordedBy===b.instruction.recordedBy&&a.instruction.recordedAt===b.instruction.recordedAt;
}
export async function saveCuttingInstruction(id:string,expectedUpdatedAt:number,input:CuttingInstructionInput,actor:Pick<User,'id'|'role'>):Promise<CuttingIncoming>{
  if(!actor.id||![UserRole.CHIEF,UserRole.MASTER,UserRole.TECHNOLOGIST].includes(actor.role))throw new Error('Назначать нарезку может только технолог, мастер или начальник локального цеха');
  validateInstructionInput(input);
  return db.transaction('rw',db.calenderRuns,db.rollSpecs,db.cuttingRolls,async()=>{
    const existing=await db.cuttingRolls.get(id);
    const clean={...input,electrodeWidthMm:input.electrodeType==='prismatic'?input.electrodeWidthMm:undefined,
      coatingType:input.coatingType?.trim()||undefined,techNotes:input.techNotes?.trim()||undefined};
    if(existing){
      const retry={...existing,...clean,instruction:existing.instruction?{...existing.instruction,recordedBy:actor.id,calenderUpdatedAt:expectedUpdatedAt}:undefined};
      if(sameCuttingInstruction(existing,retry))return existing;
      throw new Error('Для этого результата уже есть другое задание. Исходная запись сохранена; требуется отдельное согласованное исправление.');
    }
    const source=await db.calenderRuns.get(id);
    const roll=source&&await db.rollSpecs.get(source.rollId);
    if(!source||!roll||source.updatedAt!==expectedUpdatedAt)throw new Error('Результат изменён или отсутствует. Обновите выбор источника.');
    const now=Date.now();
    const instruction:CuttingIncoming={...clean,id,roll,calender:source,thicknessAfterUm:source.thicknessAfterUm,
      instruction:{recordedBy:actor.id,recordedAt:now,calenderUpdatedAt:source.updatedAt},createdAt:now};
    validateCuttingIncoming(instruction);
    await db.cuttingRolls.add(instruction);return instruction;
  });
}
