import React,{useRef,useState} from 'react';
import {useLiveQuery} from 'dexie-react-hooks';
import {db} from '../../core/db';
import {type CalenderRun,type CuttingIncoming,UserRole} from '../../core/types';
import {useAuthStore} from '../../core/store/authStore';
import {saveCuttingInstruction} from '../../core/manufacturing/cuttingInstruction';
import {hasCalenderResult} from './calenderJournal';

const field='w-full min-h-11 rounded border border-slate-600 bg-slate-900 p-2 text-sm text-white';
export function CuttingInstructionPanel({runs,onPrepared}:{runs:CalenderRun[];onPrepared:(value:CuttingIncoming)=>void}){
 const actor=useAuthStore(s=>s.currentUser);
 const eligible=runs.filter(r=>hasCalenderResult(r)&&!r.hasDefects);
 const [source,setSource]=useState('');const [shape,setShape]=useState('');
 const [length,setLength]=useState(''),[width,setWidth]=useState(''),[plate,setPlate]=useState('');
 const [coating,setCoating]=useState(''),[notes,setNotes]=useState('');
 const [error,setError]=useState(''),[busy,setBusy]=useState(false);const inFlight=useRef(false);
 const history=useLiveQuery(()=>db.cuttingRolls.toArray(),[]);
 const selected=eligible.find(r=>r.id===source);
 // Freeze the chosen source version; a background result edit requires reselection.
 const version=useRef<number|undefined>(undefined);
 if(!actor||![UserRole.CHIEF,UserRole.MASTER,UserRole.TECHNOLOGIST].includes(actor.role))return null;
 async function submit(event:React.FormEvent){
  event.preventDefault();if(!actor||!selected||inFlight.current)return;
  inFlight.current=true;setBusy(true);setError('');
  try{
   const saved=await saveCuttingInstruction(source,version.current!,{electrodeType:shape as 'strip'|'prismatic',
    electrodeLengthMm:length===''?NaN:Number(length),webWidthMm:width===''?NaN:Number(width),
    electrodeWidthMm:plate===''?undefined:Number(plate),coatingType:coating,techNotes:notes},actor);
   onPrepared(saved);
  }catch(cause){setError(cause instanceof Error?cause.message:'Задание не сохранено');}
  finally{inFlight.current=false;setBusy(false);}
 }
 return <section className="space-y-3 rounded border border-slate-700 p-3">
  <h3 className="text-white font-semibold">Явное задание на нарезку</h3>
  <p className="text-xs text-slate-400">Локальное назначение технолога/мастера, не серверное разрешение и не приёмка ОТК. Укажите размеры по техкарте: длина вдоль полотна, ширина пластины поперёк. Физическую длину и фактические количества оператор запишет отдельно. Пакет готовится после сохранения; доставка требует ключ цеха.</p>
  {!eligible.length&&<p className="text-amber-200 text-sm">Нет полных результатов без отмеченных дефектов. Сначала сохраните измеренный результат прокатки.</p>}
  <form onSubmit={event=>void submit(event)}><fieldset disabled={busy} className="space-y-3">
   <label className="block text-sm text-slate-300">Источник результата
    <select aria-label="Источник задания нарезки" className={field} value={source} onChange={e=>{
     setSource(e.target.value);version.current=eligible.find(r=>r.id===e.target.value)?.updatedAt;
     setShape('');setLength('');setWidth('');setPlate('');setCoating('');setNotes('');setError('');
    }}><option value="">Выберите результат</option>{eligible.map(r=><option key={r.id} value={r.id}>{r.rollId} · {r.totalLengthM} м · {r.thicknessAfterUm} мкм</option>)}</select>
   </label>
   <label className="block text-sm text-slate-300">Тип электрода
    <select aria-label="Тип электрода для задания" className={field} value={shape} onChange={e=>{setShape(e.target.value);setPlate('');}}><option value="">Выберите тип</option><option value="strip">Полосы</option><option value="prismatic">Прямоугольные пластины</option></select>
   </label>
   <label className="block text-sm text-slate-300">Длина электрода по заданию, мм<input aria-label="Длина электрода по заданию, мм" type="number" step="any" className={field} value={length} onChange={e=>setLength(e.target.value)}/></label>
   <label className="block text-sm text-slate-300">Ширина полотна по заданию, мм<input aria-label="Ширина полотна по заданию, мм" type="number" step="any" className={field} value={width} onChange={e=>setWidth(e.target.value)}/></label>
   {shape==='prismatic'&&<label className="block text-sm text-slate-300">Ширина пластины по заданию, мм<input aria-label="Ширина пластины по заданию, мм" type="number" step="any" className={field} value={plate} onChange={e=>setPlate(e.target.value)}/></label>}
   <label className="block text-sm text-slate-300">Тип покрытия (необязательно)<input aria-label="Покрытие для задания" className={field} value={coating} onChange={e=>setCoating(e.target.value)}/></label>
   <label className="block text-sm text-slate-300">Указания технолога<textarea aria-label="Указания для нарезки" className={field} value={notes} onChange={e=>setNotes(e.target.value)}/></label>
   {error&&<p role="alert" className="text-red-200 text-sm">{error}</p>}
   <button disabled={!selected||!shape||busy} type="submit" className="min-h-11 rounded bg-blue-600 p-3 text-white disabled:opacity-40">Сохранить задание и подготовить пакет</button>
  </fieldset></form>
  <div className="space-y-2 text-xs text-slate-300">{history?.filter(row=>row.instruction).map(row=><p key={row.id}>Задание {row.id}: {row.electrodeType==='strip'?'полосы':'пластины'}, {row.electrodeLengthMm} × {row.electrodeWidthMm??'—'} мм; полотно {row.webWidthMm} мм · Автор: {row.instruction!.recordedBy} · {new Date(row.instruction!.recordedAt).toLocaleString('ru-RU')}</p>)}</div>
 </section>;
}
