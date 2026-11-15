import React,{useRef,useState} from 'react';
import {v4 as uuidv4} from 'uuid';
import type {ElectrolyteIncoming,ElectrolyteBox,User} from '../../core/types';
import {CELL_OUTPUT_ROLES} from '../../core/manufacturing/assemblyCellOutput';
import {acceptFillingHandover} from '../../core/manufacturing/fillingHandover';
export function FillingHandoverCard({row,box,actor,onPacket}:{row:ElectrolyteIncoming;box:ElectrolyteBox;actor:User|null;onPacket:(row:ElectrolyteIncoming)=>void}){
 const [count,setCount]=useState(''),[note,setNote]=useState(''),[busy,setBusy]=useState(false),[error,setError]=useState('');const lock=useRef(false);const attempt=useRef<{id:string;count:number;note:string}|null>(null);
 const accept=async()=>{
  if(lock.current||!actor)return;lock.current=true;setBusy(true);setError('');
  try{if(!count.trim()||Number(count)!==row.cellsIn||!note.trim())throw new Error('Введите полное фактически принятое количество и основание явно');
   if(!attempt.current)attempt.current={id:uuidv4(),count:Number(count),note:note.trim()};
   await acceptFillingHandover(row,box,actor.id,attempt.current.count,attempt.current.note,attempt.current.id);}
  catch(cause){setError(cause instanceof Error?cause.message:'Приёмка не сохранена');}finally{lock.current=false;setBusy(false);}
 };
 return <article className="space-y-2 p-3 rounded-xl border border-slate-700 bg-slate-800/60 text-sm text-slate-300 min-w-0">
  <p className="text-white font-medium break-all">{row.batchName} · назначено {row.cellsIn} ячеек · {row.box}</p>
  <p className="text-xs break-all">Заявление выхода: {row.handover!.outputId} · сборка {row.fromAssemblyRunId}</p>
  <p className="text-xs break-all">Номера: {row.serialRange?.prefix??''}{row.serialRange?.start}–{row.serialRange?.end} · назначил {row.handover!.preparedBy} · {new Date(row.handover!.preparedAt).toLocaleString()}</p>
  {row.receipt?<div className="text-xs space-y-1"><p className="text-emerald-300">Приёмка записана: {row.receipt.count} ячеек · {row.receipt.recordedBy} · {new Date(row.receipt.recordedAt).toLocaleString()}</p><p>Основание: {row.receipt.note}</p><p>Результат заливки записывается отдельно; приёмка не является QA-допуском.</p></div>:<>
   <p className="text-amber-200 text-xs">Ожидается явная приёмка в этом боксе. Пакет передачи не подтверждает физическое получение.</p>
   {actor?.id===row.handover!.preparedBy?<p className="text-xs">Приёмку записывает другой активный профиль.</p>:actor&&<div className="space-y-2">
    <label className="block text-xs">Фактически принято, ячеек<input aria-label="Фактически принято, ячеек" disabled={busy||!!attempt.current} type="number" value={count} onChange={e=>setCount(e.target.value)} className="block min-h-11 w-full bg-slate-900 border border-slate-700 rounded p-2"/></label>
    <label className="block text-xs">Основание приёмки<input aria-label="Основание приёмки" disabled={busy||!!attempt.current} value={note} onChange={e=>setNote(e.target.value)} maxLength={1000} className="block min-h-11 w-full bg-slate-900 border border-slate-700 rounded p-2"/></label>
    <button disabled={busy} onClick={()=>void accept()} className="min-h-11 px-3 rounded bg-emerald-700">Записать приёмку в этом боксе</button>
   </div>}
  </>}
  {error&&<p role="alert" className="text-red-300 text-xs">{error}</p>}
  {error&&attempt.current&&<button disabled={busy} className="min-h-11 px-3 bg-slate-700 rounded" onClick={()=>{attempt.current=null;setError('');}}>Изменить незаписанный черновик приёмки</button>}
  {actor&&(CELL_OUTPUT_ROLES.includes(actor.role)||row.receipt?.recordedBy===actor.id)&&<button onClick={()=>onPacket(row)} className="min-h-11 px-3 rounded bg-cyan-700">{row.receipt?'Пакет с квитанцией приёмки':'Пакет передачи (без приёмки)'}</button>}
 </article>;
}
