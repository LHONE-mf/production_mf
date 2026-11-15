import React,{useRef,useState} from 'react';
import {v4 as uuidv4} from 'uuid';
import type {AssemblyRun,AssemblyCellOutput,User} from '../../core/types';
import {declareAssemblyCellOutput,eligibleAssemblyCellOperations} from '../../core/manufacturing/assemblyCellOutput';

export function AssemblyCellOutputForm({run,actor}:{run:AssemblyRun;actor:User}){
 const [open,setOpen]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState('');
 const [form,setForm]=useState({operationId:'',count:'',cellType:'',prefix:'',start:'',end:'',note:''});
 const lock=useRef(false),attempt=useRef<AssemblyCellOutput|null>(null);
 const set=(key:keyof typeof form)=>(e:React.ChangeEvent<HTMLInputElement|HTMLSelectElement|HTMLTextAreaElement>)=>setForm({...form,[key]:e.target.value});
 const eligible=eligibleAssemblyCellOperations(run);
 const save=async()=>{
  if(lock.current)return;lock.current=true;setBusy(true);setError('');
  try{
   if(!attempt.current){
    if(!form.count.trim()||!form.start.trim()||!form.end.trim()||!['cylindrical','prismatic'].includes(form.cellType))throw new Error('Укажите количество, формат и оба номера явно; пустое значение не является нулём');
    attempt.current={id:uuidv4(),operationId:form.operationId,count:Number(form.count),cellType:form.cellType as 'cylindrical'|'prismatic',serialRange:{prefix:form.prefix.trim()||undefined,start:Number(form.start),end:Number(form.end)},recordedBy:actor.id,recordedRole:actor.role,recordedAt:new Date().toISOString(),note:form.note.trim()};
   }
   await declareAssemblyCellOutput(run,attempt.current,actor.id);
  }catch(cause){setError(cause instanceof Error?cause.message:'Выход не сохранён');}
  finally{lock.current=false;setBusy(false);}
 };
 const cls='block w-full min-w-0 max-w-full min-h-11 p-2 rounded bg-slate-900 border border-slate-700';
 if(run.cellOutput){const out=run.cellOutput;return <div className="text-xs text-slate-300 break-all space-y-1">
  <p>Заявлено: {out.count} ячеек · {out.cellType==='cylindrical'?'цилиндрические':'призматические'} · номера {out.serialRange.prefix??''}{out.serialRange.start}–{out.serialRange.end}</p>
  <p>Операция: {out.operationId} · {out.recordedBy} · {new Date(out.recordedAt).toLocaleString()}</p><p>Основание: {out.note}</p>
  <p className="text-amber-200">Локальное заявление подсчёта, не QA-допуск. Передача в заливку требует отдельной проверки приёмки.</p>
 </div>;}
 if(!open)return <button className="min-h-11 px-3 bg-blue-700 rounded text-sm" onClick={()=>setOpen(true)}>Заявить выход ячеек и номера</button>;
 return <section className="w-full min-w-0 space-y-3 text-xs text-slate-300 border-t border-slate-700 pt-3">
  <p>Отдельное заявление полного выхода одной конечной операции, уже записанной в ячейках. Количество и формат не рассчитываются из электродов. Это не QA-допуск и не серверное разрешение.</p>
  {eligible.length===0&&<p className="text-amber-200">Нужна одна конечная операция с положительным выходом в ячейках и явной историей источников.</p>}
  <fieldset disabled={busy||!!attempt.current} className="min-w-0 space-y-2">
   <label className="block">Операция выхода<select aria-label="Операция выхода" className={cls} value={form.operationId} onChange={set('operationId')}><option value="">— выберите —</option>{eligible.map(op=><option key={op.id} value={op.id}>{op.substation} · {op.id} · {op.qtyOut} ячеек</option>)}</select></label>
   <label className="block">Заявленный выход, ячеек<input aria-label="Заявленный выход, ячеек" className={cls} type="number" value={form.count} onChange={set('count')}/></label>
   <label className="block">Формат ячейки<select aria-label="Формат ячейки" className={cls} value={form.cellType} onChange={set('cellType')}><option value="">— укажите явно —</option><option value="cylindrical">Цилиндрическая</option><option value="prismatic">Призматическая</option></select></label>
   <label className="block">Префикс номеров<input aria-label="Префикс номеров" className={cls} maxLength={80} value={form.prefix} onChange={set('prefix')}/></label>
   <div className="grid grid-cols-2 gap-2"><label>Первый номер<input aria-label="Первый номер" className={cls} type="number" value={form.start} onChange={set('start')}/></label><label>Последний номер<input aria-label="Последний номер" className={cls} type="number" value={form.end} onChange={set('end')}/></label></div>
   <label className="block">Основание подсчёта<input aria-label="Основание подсчёта" className={cls} maxLength={1000} value={form.note} onChange={set('note')}/></label>
  </fieldset>
  {error&&<p role="alert" className="text-red-300">{error}</p>}
  <div className="flex flex-wrap gap-2"><button disabled={busy} onClick={()=>void save()} className="min-h-11 px-3 bg-emerald-700 rounded">Сохранить заявление выхода</button>
  {attempt.current&&error&&<button disabled={busy} className="min-h-11 px-3 bg-slate-800 rounded" onClick={()=>{attempt.current=null;setError('');}}>Изменить незаписанный черновик</button>}</div>
 </section>;
}
