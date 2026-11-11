import React,{useRef,useState} from 'react';
import {v4 as uuidv4} from 'uuid';
import type {ElectrolyteIncoming,FillRun,User} from '../../core/types';
import {FILLING_UNITS,saveFillingResult,validateFillingResult} from '../../core/manufacturing/fillingResults';

const empty={electrolyteName:'',measurementBasis:'',machineNo:'',doseActual:'',vacuumKpa:'',pressureKpa:'',dwellMin:'',temperatureC:'',humidityPpm:'',cellsIn:'',cellsFilled:'',cellsScrap:'',cellsUnknown:'',defects:'',comment:''};
const measurements=[['doseActual','Доза фактическая, мг'],['vacuumKpa','Вакуум, кПа (измерено)'],['pressureKpa','Давление, кПа (измерено)'],['dwellMin','Выдержка, мин (измерено)'],['temperatureC','Температура, °C (измерено)'],['humidityPpm','Влажность, ppm (измерено)'],['cellsIn','Подано, ячеек'],['cellsFilled','Залито, ячеек (без QA)'],['cellsScrap','Отклонено, ячеек'],['cellsUnknown','Не определено, ячеек']] as const;
const input='block min-h-11 w-full min-w-0 rounded border border-slate-700 bg-slate-900 p-2 text-sm text-white';
export function FillingResultForm({source,actor,onSaved}:{source:ElectrolyteIncoming;actor:User;onSaved:(run:FillRun,send:boolean)=>void}){
 const [form,setForm]=useState(empty),[error,setError]=useState(''),[busy,setBusy]=useState(false);
 const lock=useRef(false),attempt=useRef<FillRun|null>(null);
 const save=async(send:boolean)=>{
  if(lock.current)return;lock.current=true;setBusy(true);setError('');
  try{
   if(!attempt.current){
    const values=Object.fromEntries(measurements.map(([key])=>{
     const raw=form[key].trim().replace(',','.');
     if(!/^-?(?:\d+(?:\.\d*)?|\.\d+)$/.test(raw))throw new Error('Введите измерения и все количества явно. Пустое значение не считается нулём.');
     return [key,Number(raw)];
    }));
    const now=new Date().toISOString();
    const draft:FillRun={id:uuidv4(),resultVersion:1,sourceReceipt:source,box:source.box,batchName:source.batchName,cellType:source.cellType,serialRange:source.serialRange,
     ...values,cellsIn:values.cellsIn,cellsFilled:values.cellsFilled,cellsScrap:values.cellsScrap,cellsUnknown:values.cellsUnknown,
     electrolyteName:form.electrolyteName.trim(),measurementBasis:form.measurementBasis.trim(),measurementUnits:FILLING_UNITS,machineNo:form.machineNo.trim()||undefined,
     defects:form.defects.split(',').map(v=>v.trim()).filter(Boolean),comment:form.comment.trim()||undefined,workerId:actor.id,recordedRole:actor.role,createdAt:now,updatedAt:now};
    validateFillingResult(draft);attempt.current=draft;
   }
   const saved=await saveFillingResult(attempt.current,actor.id);onSaved(saved,send);
  }catch(cause){setError(cause instanceof Error?cause.message:'Результат не сохранён');}finally{lock.current=false;setBusy(false);}
 };
 const field=(key:keyof typeof empty,label:string)=> <label key={key} className="block min-w-0 text-xs text-slate-300">{label}<input aria-label={label} className={input} value={form[key]} onChange={e=>setForm({...form,[key]:e.target.value})} inputMode={measurements.some(([k])=>k===key)?'decimal':undefined} maxLength={1000}/></label>;
 return <div className="space-y-3 rounded-xl border border-slate-700 bg-slate-800/60 p-3 min-w-0">
  <p className="text-sm text-white break-all">{source.batchName} · принято {source.cellsIn} · {source.cellType} · {source.serialRange?.prefix}{source.serialRange?.start}–{source.serialRange?.end}</p>
  <p className="text-xs text-slate-400 break-all">Квитанция {source.receipt!.id} · {source.receipt!.recordedBy} · время приёмки {source.receipt!.recordedAt}. Бокс и источник фиксированы.</p>
  <p className="text-xs text-amber-200">Это запись наблюдений, без QA-допуска. Укажите весь принятый выход: залито + отклонено + не определено. При отклонениях номера залитых ячеек неизвестны; передача части диапазона заблокирована. Влажность — только ppm, не точка росы.</p>
  <fieldset disabled={busy||!!attempt.current} className="grid grid-cols-1 sm:grid-cols-2 gap-3 min-w-0">
   {field('electrolyteName','Электролит')}{field('machineNo','Оборудование (если известно)')}
   {field('measurementBasis','Основание измерений: доза на что, база давления, среда')}
   {measurements.map(([key,label])=>field(key,label))}
   {field('defects','Наблюдаемые дефекты (через запятую)')}{field('comment','Примечание')}
  </fieldset>
  {error&&<p role="alert" className="text-red-300 text-sm">{error}</p>}
  <div className="flex flex-wrap gap-2">
   <button disabled={busy} onClick={()=>void save(false)} className="min-h-11 rounded bg-slate-700 px-3 text-sm text-white">Сохранить в журнал</button>
   <button disabled={busy} onClick={()=>void save(true)} className="min-h-11 rounded bg-cyan-700 px-3 text-sm text-white">Сохранить и передать ▸</button>
   {error&&attempt.current&&<button disabled={busy} onClick={()=>{attempt.current=null;setError('');}} className="min-h-11 rounded bg-slate-700 px-3 text-sm text-white">Изменить незаписанный черновик</button>}
  </div>
 </div>;
}
