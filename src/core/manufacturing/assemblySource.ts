import type {AssemblyOp,AssemblyRun} from '../types';
/** Full allocation only. These are recorded links, not physical stock postings. */
export function validateAssemblySources(run:AssemblyRun):void {
 const used=new Set<string>();const previous:AssemblyOp[]=[];let started=false;
 for(const op of run.ops){
  if(op.source===undefined){if(started||run.intake)throw new Error('Новая операция должна явно указать источник');previous.push(op);continue;}
  if(run.sourceLedger!==1)throw new Error('Источник требует новой версии журнала связей');
  started=true;const source=op.source;let key:string;
  if(source.kind==='intake'){
   if(!run.intake||source.sortRunId!==run.intake.sortRunId||op.qtyIn!==run.intake.electrodeCount||op.units?.input!=='electrodes')throw new Error('Вход должен точно соответствовать принятой сортировке в электродах');
   key='intake:'+source.sortRunId;
  }else if(source.kind==='operation'){
   const parent=previous.find(row=>row.id===source.operationId);
   if(!parent||parent.id===op.id||!Number.isSafeInteger(parent.qtyOut)||parent.qtyOut<=0||!parent.units?.output||parent.qtyOut!==op.qtyIn||parent.units.output!==op.units?.input)throw new Error('Предшественник должен быть ранее записан в этой партии, а его полный выход и единица — совпадать со входом');
   key='operation:'+source.operationId;
  }else if(source.kind==='declared'){
   if(run.intake||typeof source.reference!=='string'||!source.reference.trim()||source.reference!==source.reference.trim()||source.reference.length>160)throw new Error('Укажите явный внешний источник для старой партии');
   key='declared:'+source.reference;
  }else throw new Error('Неизвестный вид источника');
  if(used.has(key))throw new Error('Полный выход источника уже распределён; разделение не поддерживается');used.add(key);
  const units=op.units;
  if(units?.input===units?.output&&units?.input===units?.scrap){
   const total=op.qtyOut+op.qtyScrap;
   if(!Number.isSafeInteger(total)||total!==op.qtyIn)throw new Error('В одинаковых единицах выход и брак должны точно составлять вход');
  }else if(typeof op.conversionNote!=='string'||!op.conversionNote.trim()||op.conversionNote.length>1000)throw new Error('Укажите основание для разных единиц; автоматический пересчёт не выполняется');
  previous.push(op);
 }
 if(run.sourceLedger===1&&!started)throw new Error('Отсутствует явная связь с источником');
}
export function declaredAssemblySources(run:AssemblyRun):string[]{
 return run.ops.flatMap(op=>op.source?.kind==='declared'?[op.source.reference]:[]);
}
