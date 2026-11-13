import React,{useRef,useState} from 'react';
import {useLiveQuery} from 'dexie-react-hooks';
import {db} from '../../core/db';
import {type MixBatch,type SyncPacket,StageId} from '../../core/types';
import {useAuthStore} from '../../core/store/authStore';
import {hasMeasuredSlurryBatch,validateMeasuredSlurryBatch,prepareSlurryHandover} from '../../core/manufacturing/slurryBatch';
import {PacketOutModal} from '../_ui/PacketOutModal';
const num=(v:unknown)=>typeof v==='number'&&Number.isFinite(v)?v.toLocaleString('ru-RU',{maximumSignificantDigits:12}):'неизвестно';
export function MixBatchJournal(){
 const actor=useAuthStore(s=>s.currentUser);const batches=useLiveQuery(async()=>(await db.mixBatches.toArray()).sort((a,b)=>b.createdAt-a.createdAt),[]);
 const [open,setOpen]=useState<string|null>(null),[packet,setPacket]=useState<SyncPacket|null>(null),[error,setError]=useState(''),[busy,setBusy]=useState(false);const lock=useRef(false);
 const send=async(expected:MixBatch,toCoating:boolean)=>{
  if(!actor||lock.current)return;lock.current=true;setBusy(true);setError('');
  try{
   const saved=await db.mixBatches.get(expected.id);if(!saved||JSON.stringify(saved)!==JSON.stringify(expected))throw new Error('Запись изменена; обновите выбор перед передачей');
   if(hasMeasuredSlurryBatch(saved))validateMeasuredSlurryBatch(saved);
   if(toCoating){const snap=await prepareSlurryHandover(saved,actor.id);setPacket({v:1,type:'coating-mix',stage:StageId.COATING,payload:snap,from:actor.id,role:actor.role,ts:Date.now()});}
   else setPacket({v:1,type:'mix-batch',stage:StageId.SLURRY,payload:saved,from:actor.id,role:actor.role,ts:Date.now()});
  }catch(cause){setError(cause instanceof Error?cause.message:'Передача не подготовлена');}finally{lock.current=false;setBusy(false);}
 };
 return <div className="space-y-3 min-w-0">
  <h3 className="font-semibold text-white">📒 Журнал измеренных замесов</h3>
  <p className="text-xs text-slate-400">Сохранённые навески и версии источников. Передача не меняет запись и не подтверждает физическое получение, QA или запасы.</p>
  {error&&<p role="alert" className="text-sm text-red-300">{error}</p>}
  {(batches??[]).map(batch=>{
   const measured=hasMeasuredSlurryBatch(batch);const weights=Array.isArray(batch.weighings)?batch.weighings.filter(row=>row&&typeof row==='object'):[];
   const complete=weights.length>0&&weights.every(row=>typeof row.actualG==='number'&&Number.isFinite(row.actualG)&&row.actualG>=0);
   const actualTotal=measured?batch.massBalance?.totalActualG:complete?weights.reduce((sum,row)=>sum+row.actualG,0):undefined;
   return <article key={batch.id} className="space-y-2 rounded-xl border border-slate-700 bg-slate-800/60 p-3 min-w-0">
    <button className="min-h-11 w-full text-left text-white break-all" onClick={()=>setOpen(open===batch.id?null:batch.id)}>{batch.batchCode??'Историческая запись'} · {batch.recipeName} · {new Date(batch.createdAt).toLocaleString('ru-RU')} {open===batch.id?'▲':'▼'}</button>
    <p className="text-xs text-slate-300">План СВ: {num(batch.batchKg)} кг · полная фактическая масса: {num(actualTotal)} г</p>
    {measured?<p className="text-xs text-slate-300">СВ по навескам и составу: {num(batch.massBalance?.solidsPctMass)} % масс. · сухая масса {num(batch.massBalance?.solidsActualG)} г · жидкая часть {num(batch.massBalance?.liquidActualG)} г</p>:<p className="text-xs text-amber-200">Историческая запись без закреплённых версий состава. Свойства и происхождение требуют проверки; новый измеренный источник не создаётся автоматически.</p>}
    <p className="text-xs text-slate-300">Измеренная вязкость: {num(batch.viscosity)} мПа·с · перетир: {num(batch.fineness)} мкм · измеренная плотность: {num(batch.measuredDensity)} г/см³</p>
    {open===batch.id&&<div className="space-y-2 border-t border-slate-700 pt-2">
     <p className="text-xs text-slate-400 break-all">ID {batch.id} · автор {batch.workerId} · версия рецепта {batch.recipeSnapshot?.updatedAt??'не закреплена'} · основание: {batch.measurementNote??'не записано'}</p>
     {weights.map((row,i)=>{const component=batch.componentSnapshots?.find(c=>c.id===row.componentId);const delta=typeof row.actualG==='number'&&Number.isFinite(row.actualG)&&typeof row.plannedG==='number'&&Number.isFinite(row.plannedG)?row.actualG-row.plannedG:undefined;return <div key={row.componentId+'-'+i} className="rounded bg-slate-900 p-2 text-xs text-slate-300 break-all"><p>{component?.name??row.componentId} · версия {component?.updatedAt??'не закреплена'} · СВ {num(component?.solidsMassFraction===undefined?undefined:component.solidsMassFraction*100)} % масс.</p><p>План: {num(row.plannedG)} г · Факт: {num(row.actualG)} г · Δ: {num(delta)} г</p></div>;})}
     {batch.recipeSnapshot?.mode?.length?<details className="text-xs text-slate-400"><summary>Плановый режим рецепта (не фактический)</summary><pre className="whitespace-pre-wrap break-all">{JSON.stringify(batch.recipeSnapshot.mode,null,2)}</pre></details>:null}
     {batch.modeActual?.length?<p className="text-xs text-amber-200">В старой записи есть поле режима; его происхождение не подтверждено новым измеренным потоком.</p>:null}
     {batch.pasteCalc&&<p className="text-xs text-amber-200">Исторические модельные свойства: они не являются измерением пасты.</p>}
     {batch.notes&&<p className="text-xs text-slate-300 break-all">Примечания: {batch.notes}</p>}
     <div className="flex flex-wrap gap-2"><button disabled={busy} className="min-h-11 rounded bg-cyan-700 px-3 text-sm text-white" onClick={()=>void send(batch,false)}>Передать сохранённый замес</button>{measured&&<button disabled={busy} className="min-h-11 rounded bg-emerald-700 px-3 text-sm text-white" onClick={()=>void send(batch,true)}>Подготовить передачу на намазку</button>}</div>
    </div>}
   </article>;
  })}
  {batches?.length===0&&<p className="text-sm text-slate-400">Журнал пуст. Выберите материалы и запишите фактические навески.</p>}
  {packet&&<PacketOutModal packet={packet} onClose={()=>setPacket(null)}/>}
 </div>;
}
